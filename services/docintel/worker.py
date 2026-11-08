"""ResearchLens document-intelligence worker.

Pulls `docintel` jobs from public.ingestion_jobs (no inbound network surface), runs Docling
(layout, tables, figures, OCR fallback) and writes results to the PRIVATE `research-derived`
bucket under the document owner's prefix, then queues an `index` job for the Node indexer.

Env (required): SUPABASE_URL, SUPABASE_SECRET_KEY. Optional: WORKER_ID, POLL_SECONDS.
Security: the secret key is only sent to SUPABASE_URL and never logged; every job's document is
re-read and its storage path must start with "<owner_id>/" before anything is downloaded;
outputs are written only under that same owner/project/document prefix.
Usage: python worker.py [--once]
"""
import json, os, sys, time, tempfile, urllib.request, urllib.error, urllib.parse, socket

from extract import extract

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SECRET_KEY", "")
WORKER = os.environ.get("WORKER_ID", f"docintel-{socket.gethostname()}")[:100]
POLL = float(os.environ.get("POLL_SECONDS", "10"))
DERIVED = "research-derived"
BUCKETS = {"paper": "research-papers", "note": "research-notes"}


def log(event, **kw):  # operational metadata only — never document text or secrets
    print(json.dumps({"event": event, "worker": WORKER, **kw}), flush=True)


def call(method, path, body=None, headers=None, raw=False):
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
    if body is not None and not isinstance(body, bytes):
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(f"{URL}{path}", data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=300) as r:
        out = r.read()
        return out if raw else (json.loads(out) if out else None)


def claim():
    rows = call("POST", "/rest/v1/rpc/claim_ingestion_job", {"p_worker": WORKER, "p_kinds": ["docintel"]})
    return rows[0] if rows else None


def finish(job, status, error=None, result=None):
    patch = {"status": status, "error": (error or None) and error[:500]}
    if result is not None:
        patch["result"] = result
    q = urllib.parse.urlencode({"id": f"eq.{job['id']}", "owner_id": f"eq.{job['owner_id']}"})
    call("PATCH", f"/rest/v1/ingestion_jobs?{q}", patch, {"Prefer": "return=minimal"})


def process(job):
    owner, doc_id = job["owner_id"], job["document_id"]
    q = urllib.parse.urlencode({"id": f"eq.{doc_id}", "owner_id": f"eq.{owner}", "select": "storage_path,project_id,kind,mime_type"})
    docs = call("GET", f"/rest/v1/documents?{q}")
    if not docs:
        raise RuntimeError("document not found for owner")
    doc = docs[0]
    path = doc["storage_path"]
    if not path.startswith(f"{owner}/{doc['project_id']}/{doc_id}/"):
        raise RuntimeError("storage path does not match owner/project/document")  # defence in depth
    src = call("GET", f"/storage/v1/object/{BUCKETS[doc['kind']]}/{urllib.parse.quote(path)}", raw=True)
    prefix = f"{owner}/{doc['project_id']}/{doc_id}/derived"
    with tempfile.TemporaryDirectory() as tmp:
        suffix = ".pdf" if doc["kind"] == "paper" else "." + path.rsplit(".", 1)[-1]
        local = os.path.join(tmp, "input" + suffix)
        open(local, "wb").write(src)
        result = extract(local, os.path.join(tmp, "figures"), ocr="auto" if doc["kind"] == "paper" else "force")
        for f in result["figures"]:
            if f.get("image"):
                name = os.path.basename(f["image"])
                call("POST", f"/storage/v1/object/{DERIVED}/{prefix}/figures/{name}", open(f["image"], "rb").read(),
                     {"Content-Type": "image/png", "x-upsert": "true"})
                f["image"] = f"{prefix}/figures/{name}"
    call("POST", f"/storage/v1/object/{DERIVED}/{prefix}/docintel.json", json.dumps(result).encode(),
         {"Content-Type": "application/json", "x-upsert": "true"})
    summary = {"path": f"{prefix}/docintel.json", "pages": result["pageCount"], "tables": len(result["tables"]),
               "figures": len(result["figures"]), "ocrPages": sum(1 for p in result.get("pages", []) if p["ocr"]), "seconds": result["seconds"]}
    finish(job, "done", result=summary)
    call("POST", "/rest/v1/ingestion_jobs", {"owner_id": owner, "document_id": doc_id, "kind": "index", "result": {"docintel": summary["path"]}},
         {"Prefer": "return=minimal"})
    log("docintel.done", job=job["id"], document=doc_id, **{k: v for k, v in summary.items() if k != "path"})


def main():
    if not URL.startswith("https://") or not KEY:
        sys.exit("SUPABASE_URL (https) and SUPABASE_SECRET_KEY are required")
    once = "--once" in sys.argv
    log("worker.start")
    while True:
        job = claim()
        if job:
            try:
                process(job)
            except Exception as e:  # record a short, non-sensitive reason; job retried up to 3 attempts
                retry = job["attempts"] < 3
                finish(job, "queued" if retry else "failed", error=f"{type(e).__name__}: {str(e)[:200]}")
                log("docintel.failed", job=job["id"], retry=retry, error=type(e).__name__)
        elif once:
            break
        else:
            time.sleep(POLL)


if __name__ == "__main__":
    main()

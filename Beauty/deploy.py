import urllib.request
import json
import os

ACCOUNT_ID = "CF_ACCOUNT_ID_PLACEHOLDER"
SCRIPT_NAME = "funconnect-v1"
API_TOKEN = "CF_TOKEN_PLACEHOLDER"
DB_ID = "a3a8950d-c028-4ef4-b05c-982a10b9b2a6"
WORKER_PATH = r"C:\Projects\FunConnect\Edge\dist\worker.mjs"

# Read worker script
with open(WORKER_PATH, "rb") as f:
    script_bytes = f.read()
print(f"Script: {len(script_bytes)} bytes")

# Build multipart body
boundary = "----FunConnectDeploy"
body = b""
body += f"--{boundary}\r\n".encode()
body += b'Content-Disposition: form-data; name="metadata"\r\n'
body += b"Content-Type: application/json\r\n\r\n"
metadata = {
    "main_module": "worker.mjs",
    "workers_dev": True,
    "compatibility_date": "2026-07-09",
    "bindings": [
        {"type": "d1", "name": "DB", "id": DB_ID},
        {"type": "durable_object_namespace", "name": "CYBERPI_HUB", "class_name": "CyberpiHub"},
        {"type": "durable_object_namespace", "name": "TENANT_ROSTER", "class_name": "TenantRoster"},
        {"type": "ai", "name": "AI"},
        {"type": "plain_text", "name": "CHAT_THINKING", "text": "on"},
    ],
    "keep_bindings": ["secret_text"],
    "migrations": {"tag": "v3", "new_sqlite_classes": []},
}
body += json.dumps(metadata).encode()
body += b"\r\n"
body += f"--{boundary}\r\n".encode()
body += b'Content-Disposition: form-data; name="worker.mjs"\r\n'
body += b"Content-Type: application/javascript+module\r\n\r\n"
body += script_bytes
body += f"\r\n--{boundary}--\r\n".encode()

print(f"Body: {len(body)} bytes")

url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}"
req = urllib.request.Request(url, data=body, method="PUT")
req.add_header("Authorization", f"Bearer {API_TOKEN}")
req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")

print("Uploading...")
try:
    resp = urllib.request.urlopen(req, timeout=120)
    result = json.loads(resp.read())
    print(json.dumps(result, indent=2))
    if result.get("success"):
        print("\nDEPLOY SUCCESSFUL")
    else:
        print(f"\nDEPLOY FAILED: {json.dumps(result.get('errors', []))}")
except Exception as e:
    print(f"Error: {e}")

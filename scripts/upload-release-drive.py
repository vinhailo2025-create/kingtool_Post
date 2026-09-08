import argparse
import hashlib
import json
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload


def file_digest(path, algorithm):
    digest = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_credentials(path):
    info = json.loads(path.read_text(encoding="utf-8"))
    credentials = Credentials.from_authorized_user_info(info, info.get("scopes"))
    if not credentials.valid:
        credentials.refresh(Request())
    return credentials


def get_file(service, file_id):
    return service.files().get(
        fileId=file_id,
        fields="id,name,size,trashed,parents,md5Checksum,createdTime,modifiedTime",
        supportsAllDrives=True,
    ).execute()


def find_release_file(service, folder_id, name):
    response = service.files().list(
        q=f"'{folder_id}' in parents and trashed = false",
        spaces="drive",
        fields="files(id,name,size,trashed,parents,md5Checksum,createdTime,modifiedTime)",
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
        pageSize=1000,
    ).execute()
    matches = [item for item in response.get("files", []) if item.get("name") == name]
    if not matches:
        raise RuntimeError(f"Release file not found in the expected folder: {name}")
    if len(matches) > 1:
        raise RuntimeError(f"Multiple release files have the same name: {name}")
    return matches[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--folder-id", required=True)
    parser.add_argument("--old-file-id")
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--mime-type", default="application/zip")
    args = parser.parse_args()

    release = args.release.resolve()
    if not release.is_file():
        raise FileNotFoundError(release)

    credentials = load_credentials(args.credentials.resolve())
    service = build("drive", "v3", credentials=credentials, cache_discovery=False)
    old_file = (
        get_file(service, args.old_file_id)
        if args.old_file_id
        else find_release_file(service, args.folder_id, release.name)
    )
    if old_file.get("trashed"):
        raise RuntimeError("The old release is already trashed.")
    if args.folder_id not in old_file.get("parents", []):
        raise RuntimeError("The old release is not in the expected folder.")
    if old_file.get("name") != release.name:
        raise RuntimeError("The existing Drive file name does not match the release.")

    media = MediaFileUpload(
        str(release),
        mimetype=args.mime_type,
        chunksize=10 * 1024 * 1024,
        resumable=True,
    )
    request = service.files().update(
        fileId=old_file["id"],
        body={"name": release.name},
        media_body=media,
        fields="id,name,size,trashed,parents,md5Checksum,createdTime,modifiedTime",
        supportsAllDrives=True,
    )
    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print(json.dumps({
                "stage": "upload",
                "progressPercent": round(status.progress() * 100, 1),
            }))

    updated_file = get_file(service, response["id"])
    expected_size = release.stat().st_size
    expected_md5 = file_digest(release, "md5")
    if updated_file.get("id") != old_file.get("id"):
        raise RuntimeError("Drive changed the file ID during the update.")
    if updated_file.get("name") != release.name:
        raise RuntimeError("Uploaded release name does not match.")
    if int(updated_file.get("size", -1)) != expected_size:
        raise RuntimeError("Uploaded release size does not match.")
    if updated_file.get("md5Checksum", "").lower() != expected_md5:
        raise RuntimeError("Uploaded release MD5 does not match.")
    if updated_file.get("trashed"):
        raise RuntimeError("Uploaded release is unexpectedly trashed.")
    if args.folder_id not in updated_file.get("parents", []):
        raise RuntimeError("Uploaded release is outside the expected folder.")

    final_file = get_file(service, updated_file["id"])
    if final_file.get("trashed"):
        raise RuntimeError("Release became trashed after the update.")

    print(json.dumps({
        "stage": "complete",
        "fileId": final_file["id"],
        "fileName": final_file["name"],
        "bytes": int(final_file["size"]),
        "md5": final_file.get("md5Checksum"),
        "sha256": file_digest(release, "sha256"),
        "folderId": args.folder_id,
        "previousMd5": old_file.get("md5Checksum"),
        "trashed": bool(final_file.get("trashed")),
    }, indent=2))


if __name__ == "__main__":
    main()

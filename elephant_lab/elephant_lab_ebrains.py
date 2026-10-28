"""
Searching datasets of the EBRAINS Knowledge Graph, downloading their files and loading
them into the notebook via neo IO.

Two backends with the same result format:
    - "search": KG search API (https://search.kg.ebrains.eu), no login needed
    - "fairgraph": KG Core API via fairgraph (optional), needs an EBRAINS login,
      see elephant_lab_ebrains_fairgraph.py
"""

class ElephantLab_ebrains:

    import json
    import os
    import re
    import time
    import __main__
    import neo
    import urllib.error
    import urllib.parse
    import urllib.request
    from .elephant_lab_ebrains_fairgraph import ElephantLab_ebrains_fairgraph

    KG_SEARCH_API = "https://search.kg.ebrains.eu/api"
    DATA_PROXY_BUCKET_PREFIX = "https://data-proxy.ebrains.eu/api/v1/buckets/"
    DOWNLOAD_ROOT = "ebrains_data"
    REQUEST_TIMEOUT = 30
    CHUNK_SIZE = 1024 * 1024
    # Longer results are split over several ELEPHANT_LAB_RESULT_KEY lines, KernelBridge joins them
    RESULT_LINE_LENGTH = 4000
    AUTH_ACTIONS = ("status", "login_with_token", "start_login", "poll_login", "logout")

    def __init__(self):
        """
        Class to outsource some elephant lab logic:
            -all logic regarding the EBRAINS Knowledge Graph
        Is a Class to minimize the amount of name clutter in the notebook
        """
        self._neo_extensions = None
        self.fairgraph = self.ElephantLab_ebrains_fairgraph()

    def _emit_result(self, obj):
        text = self.json.dumps(obj)
        for i in range(0, len(text), self.RESULT_LINE_LENGTH):
            print(f"ELEPHANT_LAB_RESULT_KEY:{text[i:i + self.RESULT_LINE_LENGTH]}")

    def _emit_progress(self, obj):
        print(f"ELEPHANT_LAB_PROGRESS:{self.json.dumps(obj)}", flush=True)

    def _emit_error(self, prefix, error):
        """Emits an error; auth_required makes the frontend show the EBRAINS login again."""
        unreachable = isinstance(error, TimeoutError) or (
            isinstance(error, self.urllib.error.URLError) and not isinstance(error, self.urllib.error.HTTPError))
        message = "EBRAINS could not be reached, please try again later" if unreachable else str(error)
        self._emit_result({"error": f"{prefix}: {message}", "auth_required": isinstance(error, PermissionError)})

    def _request_json(self, path, body=None):
        """GET from the KG search API, or POST if a JSON body is given."""
        request = self.urllib.request.Request(
            f"{self.KG_SEARCH_API}{path}", method="GET" if body is None else "POST",
            data=None if body is None else self.json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json"})
        with self.urllib.request.urlopen(request, timeout=self.REQUEST_TIMEOUT) as response:
            return self.json.load(response)

    @staticmethod
    def _value(field):
        """Fields of the KG search API are mostly {"value": ...}."""
        return field.get("value") if isinstance(field, dict) else field

    def _is_neo_readable(self, filename, mime_type):
        """Guess based on the file extension (or the NIX/neo MIME type)."""
        if self._neo_extensions is None:
            self._neo_extensions = {ext.lower() for io in self.neo.io.iolist for ext in io.extensions}
        if mime_type and "nix.neo" in mime_type:
            return True
        return "." in filename and filename.rsplit(".", 1)[1].lower() in self._neo_extensions

    def _relative_path(self, url, filename):
        """Path of a file inside its dataset; keeps the folder structure of data-proxy buckets."""
        if url.startswith(self.DATA_PROXY_BUCKET_PREFIX):
            path_in_bucket = url[len(self.DATA_PROXY_BUCKET_PREFIX):].split("?", 1)[0].split("/", 1)
            if len(path_in_bucket) == 2:
                return self.urllib.parse.unquote(path_in_bucket[1])
        return filename

    def _safe_join(self, base_dir, relative_path):
        """Joins base_dir and a path from the KG without leaving base_dir."""
        parts = [p for p in relative_path.replace("\\", "/").split("/") if p not in ("", ".", "..")]
        target = self.os.path.abspath(self.os.path.join(base_dir, *parts))
        if not target.startswith(self.os.path.abspath(base_dir) + self.os.sep):
            raise ValueError(f"Refusing to write outside of {base_dir}: {relative_path}")
        return target

    def _dataset_folder(self, dataset_id, dataset_title):
        slug = self.re.sub(r"[^A-Za-z0-9]+", "_", dataset_title or "").strip("_")[:60]
        return self.os.path.join(self.DOWNLOAD_ROOT, f"{slug}_{dataset_id[:8]}" if slug else dataset_id)

    def _free_variable_name(self, filename):
        stem = self.os.path.splitext(self.os.path.basename(filename))[0]
        base = "ebrains_" + (self.re.sub(r"\W+", "_", stem).strip("_") or "data")
        name, counter = base, 1
        while name in self.__main__.__dict__:
            name = f"{base}_{counter}"
            counter += 1
        return name

    def _search_public(self, query, size, cursor):
        params = {"group": "public", "type": "Dataset", "size": size}
        if query:
            params["q"] = query
        if cursor:
            params["cursor"] = cursor
        data = self._request_json(f"/search?{self.urllib.parse.urlencode(params)}", body={})
        hits = data.get("hits", [])
        return {
            "total": data.get("total", 0),
            "hits": [{
                "id": hit["id"],
                "title": hit.get("title", ""),
                "accessibility": self._value(hit.get("fields", {}).get("accessibility")),
                "released": self._value(hit.get("fields", {}).get("releasedAt")),
                "custodians": [self._value(c) for c in hit.get("fields", {}).get("custodians") or []][:3],
            } for hit in hits],
            "cursor": hits[-1].get("cursor") if hits else None,
        }

    def _dataset_public(self, dataset_id):
        """Dataset metadata and its files as (name, url, format, size) tuples."""
        document = self._request_json(f"/groups/public/documents/{self.urllib.parse.quote(dataset_id)}")
        fields = document.get("fields", {})
        dataset = {
            "title": document.get("title", ""),
            "description": self._value(fields.get("description")) or "",
            "accessibility": self._value(fields.get("accessibility")),
            "doi": self._value(fields.get("doi")),
            "license": self._value(fields.get("license_info")),
        }
        files = []
        if fields.get("fileRepositoryId"):
            listing = self._request_json(
                f"/groups/public/repositories/{self.urllib.parse.quote(fields['fileRepositoryId'])}/files")
            for entry in listing.get("data", []):
                url = self._value(entry.get("iri"))
                if url:
                    files.append((self._value(entry.get("title")) or url.rsplit("/", 1)[-1], url,
                                  self._value(entry.get("format")), self._value(entry.get("size"))))
        return dataset, files

    def search(self, query, size=20, cursor=None, backend="search"):
        """Emits {"total", "hits": [{id, title, accessibility, released, custodians}], "cursor"}."""
        try:
            if backend == "fairgraph":
                self._emit_result(self.fairgraph.search(query, int(size), int(cursor or 0)))
            else:
                self._emit_result(self._search_public(query, int(size), cursor))
        except Exception as e:
            self._emit_error("Search failed", e)

    def list_files(self, dataset_id, backend="search"):
        """Emits {"dataset": {...}, "files": [{name, path, url, format, size, neo_readable}]}."""
        try:
            if backend == "fairgraph":
                dataset, files = self.fairgraph.dataset_with_files(dataset_id)
            else:
                dataset, files = self._dataset_public(dataset_id)
        except Exception as e:
            self._emit_error(f"Could not list files of dataset {dataset_id}", e)
            return
        dataset.update(id=dataset_id, folder=self._dataset_folder(dataset_id, dataset["title"]))
        entries = [{
            "name": name,
            "path": self._relative_path(url, name),
            "url": url,
            "format": mime_type,
            "size": size,
            "neo_readable": self._is_neo_readable(name, mime_type),
        } for name, url, mime_type, size in files]
        entries.sort(key=lambda entry: entry["path"].lower())
        self._emit_result({"dataset": dataset, "files": entries})

    def _open_download(self, url):
        """
        Opens url without login. If data-proxy refuses that (controlled access), the request is
        repeated with the user's token. The token must not reach the storage server data-proxy
        redirects to, which answers bearer tokens with 400 InvalidArgument; urllib does not
        forward unredirected headers.
        """
        try:
            return self.urllib.request.urlopen(url, timeout=self.REQUEST_TIMEOUT)
        except self.urllib.error.HTTPError as e:
            auth_header = self.fairgraph.auth_header()
            if e.code not in (401, 403) or not auth_header or not url.startswith(self.DATA_PROXY_BUCKET_PREFIX):
                raise
        request = self.urllib.request.Request(url)
        request.add_unredirected_header("Authorization", auth_header)
        return self.urllib.request.urlopen(request, timeout=self.REQUEST_TIMEOUT)

    def _download_error(self, error):
        """Error message naming the server and its error code (e.g. <Code> of S3 errors)."""
        if not isinstance(error, self.urllib.error.HTTPError):
            return str(error)
        host = self.urllib.parse.urlparse(error.geturl() or "").netloc
        body = error.read(2000).decode("utf-8", "replace")
        code = self.re.search(r"<Code>([^<]+)</Code>", body)
        message = f"HTTP {error.code} {error.reason} from {host}: {code.group(1) if code else body.strip()[:200]}"
        if error.code in (401, 403):
            message += " (needs an EBRAINS login with access to the dataset)"
        return message

    def _download(self, url, target, label, index, count):
        """Downloads url to target via a .part file and reports progress; skips existing files."""
        if self.os.path.exists(target):
            self._emit_progress({"file": label, "index": index, "count": count, "fraction": 1.0, "skipped": True})
            return
        self.os.makedirs(self.os.path.dirname(target), exist_ok=True)
        partial = target + ".part"
        try:
            with self._open_download(url) as response, open(partial, "wb") as out:
                total = int(response.headers.get("Content-Length") or 0)
                done, last_report = 0, 0.0
                while chunk := response.read(self.CHUNK_SIZE):
                    out.write(chunk)
                    done += len(chunk)
                    if self.time.monotonic() - last_report > 0.5:
                        last_report = self.time.monotonic()
                        self._emit_progress({"file": label, "index": index, "count": count,
                                             "fraction": done / total if total else None})
            self.os.replace(partial, target)
        except BaseException:
            # BaseException also covers the KeyboardInterrupt of the cancel button (kernel interrupt)
            if self.os.path.exists(partial):
                self.os.remove(partial)
            raise
        self._emit_progress({"file": label, "index": index, "count": count, "fraction": 1.0})

    def download_and_load(self, dataset_folder, files):
        """
        Downloads files ([{path, url, load}]) into dataset_folder and reads each file with load=True
        into its own notebook variable. Files with load=False are companions, e.g. Blackrock .ccf.
        Emits {"loaded": [{variable, path}], "errors": [{path, error}]}, or {"error"} if a download failed.
        """
        to_load = []
        for i, file in enumerate(files):
            try:
                target = self._safe_join(dataset_folder, file["path"])
                self._download(file["url"], target, self.os.path.basename(target), i + 1, len(files))
            except KeyboardInterrupt:
                self._emit_result({"error": "Download cancelled."})
                return
            except Exception as e:
                self._emit_result({"error": f"Download of {self.os.path.basename(file['path'])} failed: {self._download_error(e)}"})
                return
            if file["load"]:
                to_load.append(self.os.path.relpath(target))

        loaded, errors = [], []
        for path in to_load:
            try:
                block = self.neo.get_io(path).read()
            except Exception as e:
                errors.append({"path": path, "error": f"Downloaded to {path}, but neo could not read it: {e}"})
                continue
            if isinstance(block, list):
                block = block[0]
            elif isinstance(block, dict):
                block = block["blocks"][0]
            variable_name = self._free_variable_name(path)
            self.__main__.__dict__[variable_name] = block
            loaded.append({"variable": variable_name, "path": path})
        self._emit_result({"loaded": loaded, "errors": errors})

    def auth(self, action, *args):
        """Runs a login action of the fairgraph backend (see AUTH_ACTIONS) and emits its result."""
        if action not in self.AUTH_ACTIONS:
            raise ValueError(f"Unknown EBRAINS login action: {action}")
        try:
            self._emit_result(getattr(self.fairgraph, action)(*args) or self.fairgraph.status())
        except Exception as e:
            self._emit_result({"error": str(e), **self.fairgraph.status()})

"""
fairgraph backend of the EBRAINS Knowledge Graph browser (https://fairgraph.readthedocs.io).
It uses the KG Core API, which needs an EBRAINS login and also lists controlled access
datasets the user has access to.

Login is automatic in the EBRAINS Lab (clb_nb_utils) or with the KG_AUTH_TOKEN environment
variable, otherwise via the OAuth device flow (the user confirms a code on the EBRAINS login
page) or with a pasted access token. The token is only kept in memory.
"""

class ElephantLab_ebrains_fairgraph:

    import base64
    import functools
    import json
    import logging
    import os
    import queue
    import threading
    import time
    import urllib.error
    import urllib.parse
    import urllib.request

    KG_HOST = "core.kg.ebrains.eu"
    IAM_URL = "https://iam.ebrains.eu/auth/realms/hbp/protocol/openid-connect"
    # Public OAuth client that kg-core-python (used by fairgraph) uses for its device flow
    OAUTH_CLIENT_ID = "kg-core-python"
    REQUEST_TIMEOUT = 30
    # fairgraph sends requests without timeout, a KG outage would otherwise block the kernel
    KG_CALL_TIMEOUT = 60
    # Renew the token this many seconds before it expires
    TOKEN_EXPIRY_MARGIN = 60
    # The KG cannot OR filters on different properties, so each field is queried separately
    SEARCH_FIELDS = ("full_name", "authors__family_name", "custodians__family_name")
    MAX_MATCHES_PER_FIELD = 100
    DATASET_LINKS = {"has_versions": {"accessibility": {}}, "custodians": {}}

    # fairgraph logs openMINDS validation problems of KG records (e.g. a missing release_date)
    # on the "fairgraph" logger; they are dropped while calls of this class run. Class attributes,
    # so the filter is added only once per kernel.
    _running_calls = 0
    _log_filter_added = False

    def __init__(self):
        self._client = None
        self._token = None
        self._refresh_token = None
        self._method = None
        self._device_code = None
        # False after an explicit logout, so the automatic login does not log the user in again
        self._auto_login = True
        # (query, matching datasets) of the last search, "Load more" pages through it
        self._search_cache = (None, [])
        cls = ElephantLab_ebrains_fairgraph
        if not cls._log_filter_added:
            self.logging.getLogger("fairgraph").addFilter(lambda record: cls._running_calls == 0)
            cls._log_filter_added = True

    @staticmethod
    def is_installed():
        try:
            import fairgraph  # noqa: F401
        except ImportError:
            return False
        return True

    def _run(self, *calls):
        """
        Runs fairgraph calls (functions without arguments) in parallel threads and returns their
        results. Raises the first error of a call, or TimeoutError after KG_CALL_TIMEOUT seconds.
        """
        results = self.queue.Queue()

        def run(index, call):
            try:
                results.put((index, None, call()))
            except BaseException as e:
                results.put((index, e, None))

        cls = ElephantLab_ebrains_fairgraph
        cls._running_calls += 1
        try:
            for index, call in enumerate(calls):
                self.threading.Thread(target=run, args=(index, call), daemon=True).start()
            values = [None] * len(calls)
            deadline = self.time.monotonic() + self.KG_CALL_TIMEOUT
            for _ in calls:
                index, error, value = results.get(timeout=max(0, deadline - self.time.monotonic()))
                if error is not None:
                    raise error
                values[index] = value
            return values
        except self.queue.Empty:
            raise TimeoutError(f"The EBRAINS Knowledge Graph did not respond within {self.KG_CALL_TIMEOUT} s") from None
        finally:
            cls._running_calls -= 1

    def _post_form(self, url, data):
        """POSTs form data and returns (status, json); 4xx answers are part of the device flow."""
        request = self.urllib.request.Request(url, data=self.urllib.parse.urlencode(data).encode(), method="POST")
        try:
            with self.urllib.request.urlopen(request, timeout=self.REQUEST_TIMEOUT) as response:
                return response.status, self.json.load(response)
        except self.urllib.error.HTTPError as e:
            try:
                return e.code, self.json.load(e)
            except ValueError:
                return e.code, {}

    def _token_claims(self):
        """Unverified payload of the JWT access token (user name, expiry)."""
        try:
            payload = self._token.split(".")[1]
            return self.json.loads(self.base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        except Exception:
            return {}

    def _use_token(self, token, method, refresh_token=None):
        """Logs in with token if the KG accepts it."""
        from fairgraph import KGClient
        from fairgraph.errors import AuthenticationError, AuthorizationError
        client = KGClient(token=token, host=self.KG_HOST, allow_interactive=False)
        try:
            self._run(client.user_info)
        except (AuthenticationError, AuthorizationError):
            raise PermissionError("The Knowledge Graph did not accept the token") from None
        self._client, self._token, self._method, self._refresh_token = client, token, method, refresh_token

    def _try_automatic_login(self):
        """Logs in without user interaction in the EBRAINS Lab or with KG_AUTH_TOKEN."""
        if not self._auto_login:
            return
        try:
            import clb_nb_utils.oauth as clb_oauth
            token, method = clb_oauth.get_token(), "EBRAINS Lab"
        except Exception:
            token, method = self.os.environ.get("KG_AUTH_TOKEN"), "KG_AUTH_TOKEN"
        if token:
            try:
                self._use_token(token, method)
            except Exception:
                pass  # the user can still log in manually

    def _ensure_fresh_token(self):
        """Renews the token shortly before it expires; logs out if that is not possible."""
        expiry = self._token_claims().get("exp")
        if not expiry or self.time.time() < expiry - self.TOKEN_EXPIRY_MARGIN:
            return
        if self._method == "EBRAINS Lab":
            import clb_nb_utils.oauth as clb_oauth
            self._use_token(clb_oauth.get_token(), self._method)
            return
        if self._refresh_token:
            status, data = self._post_form(f"{self.IAM_URL}/token", {
                "grant_type": "refresh_token", "client_id": self.OAUTH_CLIENT_ID, "refresh_token": self._refresh_token})
            if status == 200:
                self._use_token(data["access_token"], self._method, data.get("refresh_token"))
                return
        self.logout()
        raise PermissionError("The EBRAINS login has expired, please log in again")

    def client(self):
        """fairgraph client of the logged-in user."""
        if not self.is_installed():
            raise ImportError("fairgraph is not installed in this kernel")
        if self._client is None:
            self._try_automatic_login()
        if self._client is None:
            raise PermissionError("Please log in to EBRAINS to use the Knowledge Graph API")
        self._ensure_fresh_token()
        return self._client

    def auth_header(self):
        """Authorization header of the logged-in user, None if nobody is logged in."""
        return f"Bearer {self._token}" if self._token else None

    def status(self):
        """{"installed", "logged_in", "user", "method"}; logs in automatically if possible."""
        if not self.is_installed():
            return {"installed": False, "logged_in": False}
        if self._client is None:
            self._try_automatic_login()
        claims = self._token_claims() if self._token else {}
        return {"installed": True, "logged_in": self._client is not None,
                "user": claims.get("name") or claims.get("preferred_username"), "method": self._method}

    def login_with_token(self, token):
        self._use_token(token.strip(), "token")
        return self.status()

    def start_login(self):
        """Starts the OAuth device flow: {"url", "user_code", "interval"}; the user confirms the code at url."""
        status, data = self._post_form(f"{self.IAM_URL}/auth/device", {"client_id": self.OAUTH_CLIENT_ID})
        if status != 200:
            raise RuntimeError(f"EBRAINS login could not be started (HTTP {status})")
        self._device_code = data["device_code"]
        return {"url": data["verification_uri_complete"], "user_code": data["user_code"], "interval": data.get("interval", 5)}

    def poll_login(self):
        """Checks once whether the user confirmed the device flow login: {"state": "pending" | "done" | "failed"}."""
        status, data = self._post_form(f"{self.IAM_URL}/token", {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "client_id": self.OAUTH_CLIENT_ID, "device_code": self._device_code})
        if status == 200:
            self._use_token(data["access_token"], "EBRAINS login", data.get("refresh_token"))
            return {"state": "done", **self.status()}
        if data.get("error") in ("authorization_pending", "slow_down"):
            return {"state": "pending"}
        return {"state": "failed", "error": data.get("error_description") or data.get("error") or f"HTTP {status}"}

    def logout(self):
        self._client = self._token = self._refresh_token = self._method = None
        self._auto_login = False

    @staticmethod
    def _name(obj):
        """Name of a linked openMINDS object; persons as "Family, G."."""
        for attribute in ("full_name", "name", "short_name"):
            if getattr(obj, attribute, None):
                return getattr(obj, attribute)
        family, given = getattr(obj, "family_name", None), getattr(obj, "given_name", None)
        if family and given:
            return f"{family}, {given[0]}."
        return family

    @staticmethod
    def _as_list(value):
        if value is None:
            return []
        return value if isinstance(value, (list, tuple)) else [value]

    @staticmethod
    def _format_size(quantity):
        """File.storage_size in bytes, formatted like the KG search API does ("93 MB")."""
        value = getattr(quantity, "value", None)
        if value is None:
            return None
        for factor, unit in ((1e12, "TB"), (1e9, "GB"), (1e6, "MB"), (1e3, "KB")):
            if value >= factor:
                return f"{round(value / factor)} {unit}"
        return f"{int(value)} bytes"

    def _matching_datasets(self, client, query):
        """Datasets whose name, author or custodian family name contains query; name matches first."""
        from fairgraph.openminds.core import Dataset
        results = self._run(*(
            self.functools.partial(Dataset.list, client, size=self.MAX_MATCHES_PER_FIELD,
                                   follow_links=self.DATASET_LINKS, **{field: query})
            for field in self.SEARCH_FIELDS))
        unique = {}
        for datasets in results:
            for dataset in datasets:
                unique.setdefault(dataset.uuid, dataset)
        return list(unique.values())

    def _hits(self, datasets):
        """One search hit per dataset version."""
        hits = []
        for dataset in datasets:
            custodians = [name for name in map(self._name, self._as_list(dataset.custodians)) if name]
            for version in self._as_list(dataset.has_versions):
                title = getattr(version, "full_name", None) or dataset.full_name or ""
                if getattr(version, "version_identifier", None):
                    title += f" ({version.version_identifier})"
                release_date = getattr(version, "release_date", None)
                hits.append({
                    "id": version.uuid,
                    "title": title,
                    "accessibility": self._name(getattr(version, "accessibility", None)),
                    "released": str(release_date) if release_date else None,
                    "custodians": custodians[:3],
                })
        return hits

    def search(self, query, size, offset):
        """
        Datasets whose name, author or custodian family name contains query, all datasets if
        query is empty. Same result format as ElephantLab_ebrains._search_public; cursor is the offset.
        """
        client = self.client()
        from fairgraph.openminds.core import Dataset
        if query:
            if offset == 0 or self._search_cache[0] != query:
                self._search_cache = (query, self._matching_datasets(client, query))
            matches = self._search_cache[1]
            datasets, total = matches[offset:offset + size], len(matches)
        else:
            datasets, total = self._run(
                self.functools.partial(Dataset.list, client, size=size, from_index=offset, follow_links=self.DATASET_LINKS),
                self.functools.partial(Dataset.count, client))
        offset += len(datasets)
        return {"total": total, "hits": self._hits(datasets), "cursor": str(offset) if offset < total else None}

    def dataset_with_files(self, dataset_id):
        """Dataset version metadata and its files as (name, url, format, size) tuples."""
        client = self.client()
        from fairgraph.openminds.core import DatasetVersion
        version, = self._run(self.functools.partial(DatasetVersion.from_id, dataset_id, client, follow_links={
            "is_version_of": {}, "accessibility": {}, "digital_identifier": {}, "license": {},
            "repository": {"files": {"format": {}}},
        }))
        if version is None:
            raise LookupError(f"Dataset version {dataset_id} was not found or is not accessible")
        parents = self._as_list(version.is_version_of)
        parent = parents[0] if parents else None
        title = version.full_name or self._name(parent) or ""
        if version.version_identifier:
            title += f" ({version.version_identifier})"
        doi = getattr(version.digital_identifier, "identifier", None)
        dataset = {
            "title": title,
            "description": version.description or getattr(parent, "description", None) or "",
            "accessibility": self._name(version.accessibility),
            "doi": doi.replace("https://doi.org/", "") if doi else None,
            "license": self._name(version.license),
        }
        files = []
        for file in self._as_list(getattr(version.repository, "files", None)):
            url = getattr(file.iri, "value", None)
            if url:
                files.append((file.name or url.rsplit("/", 1)[-1], url, self._name(file.format),
                              self._format_size(file.storage_size)))
        return dataset, files

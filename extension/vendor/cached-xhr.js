(function installBiliCdnCachedXhr(root) {
  "use strict";

  function makeEvent(type, source) {
    if (typeof ProgressEvent === "function" && source && ("loaded" in source || "total" in source)) {
      return new ProgressEvent(type, {
        lengthComputable: Boolean(source.lengthComputable),
        loaded: Number(source.loaded || 0),
        total: Number(source.total || 0)
      });
    }
    return new Event(type);
  }

  function createCachedXMLHttpRequest(options) {
    const NativeXHR = options?.NativeXHR;
    if (!NativeXHR?.prototype) return null;
    const rawAbort = options?.rawAbort || NativeXHR.prototype.abort;
    const resolveCachedRequest = typeof options?.resolveCachedRequest === "function"
      ? options.resolveCachedRequest
      : () => null;
    const onCacheHit = typeof options?.onCacheHit === "function" ? options.onCacheHit : () => {};

    class CachedXMLHttpRequest extends EventTarget {
      constructor() {
        super();
        this._aborted = false;
        this._async = true;
        this._headers = [];
        this._inner = null;
        this._method = "GET";
        this._mimeType = "";
        this._openRest = [];
        this._readyState = 0;
        this._requestToken = 0;
        this._responseType = "";
        this._selected = null;
        this._sent = false;
        this._settled = false;
        this._synthetic = false;
        this._timeout = 0;
        this._url = "";
        this._withCredentials = false;
        this.upload = new EventTarget();
      }

      get readyState() { return this._synthetic ? this._readyState : (this._selected?.readyState ?? this._readyState); }
      get response() { return this._selected?.response ?? null; }
      get responseText() { return this._selected?.responseText ?? ""; }
      get responseURL() { return this._selected?.responseURL ?? ""; }
      get responseXML() { return this._selected?.responseXML ?? null; }
      get status() { return Number(this._selected?.status || 0); }
      get statusText() { return this._selected?.statusText ?? ""; }
      get timeout() { return this._timeout; }
      set timeout(value) {
        this._timeout = Math.max(0, Number(value) || 0);
        if (this._inner) {
          try { this._inner.timeout = this._timeout; } catch {}
        }
      }
      get withCredentials() { return this._withCredentials; }
      set withCredentials(value) {
        this._withCredentials = Boolean(value);
        if (this._inner) {
          try { this._inner.withCredentials = this._withCredentials; } catch {}
        }
      }
      get responseType() { return this._responseType; }
      set responseType(value) {
        this._responseType = String(value || "");
        if (this._inner) {
          try { this._inner.responseType = this._responseType; } catch {}
        }
      }

      _emit(type, source = null) {
        const event = makeEvent(type, source);
        super.dispatchEvent(event);
        const handler = this[`on${type}`];
        if (typeof handler === "function") {
          try { handler.call(this, event); } catch (error) { queueMicrotask(() => { throw error; }); }
        }
      }

      open(method, url, ...rest) {
        if (this._sent && !this._settled) this.abort();
        this._requestToken += 1;
        this._aborted = false;
        this._async = rest[0] !== false;
        this._headers = [];
        this._inner = null;
        this._method = String(method || "GET");
        this._mimeType = "";
        this._openRest = rest;
        this._readyState = 1;
        this._selected = null;
        this._sent = false;
        this._settled = false;
        this._synthetic = false;
        this._url = String(url || "");
        this._emit("readystatechange");
      }

      setRequestHeader(name, value) {
        if (this._readyState !== 1 || this._sent) throw new DOMException("Invalid state", "InvalidStateError");
        this._headers.push([String(name), String(value)]);
      }

      overrideMimeType(value) {
        this._mimeType = String(value || "");
      }

      getAllResponseHeaders() {
        return this._selected?.getAllResponseHeaders?.() || "";
      }

      getResponseHeader(name) {
        return this._selected?.getResponseHeader?.(name) || null;
      }

      _applyNetworkSettings(xhr) {
        try { xhr.responseType = this._responseType; } catch {}
        try { xhr.timeout = this._timeout; } catch {}
        try { xhr.withCredentials = this._withCredentials; } catch {}
        if (this._mimeType && typeof NativeXHR.prototype.overrideMimeType === "function") {
          try { NativeXHR.prototype.overrideMimeType.call(xhr, this._mimeType); } catch {}
        }
        for (const [name, value] of this._headers) {
          NativeXHR.prototype.setRequestHeader.call(xhr, name, value);
        }
      }

      _sendNetwork(body) {
        const xhr = new NativeXHR();
        this._inner = xhr;
        this._selected = xhr;
        for (const type of ["readystatechange", "loadstart", "progress", "abort", "error", "load", "timeout", "loadend"]) {
          xhr.addEventListener(type, (event) => {
            if (type === "readystatechange" && xhr.readyState === 1) return;
            this._readyState = xhr.readyState;
            if (type === "loadend") this._settled = true;
            this._emit(type, event);
          });
        }
        NativeXHR.prototype.open.call(xhr, this._method, this._url, ...this._openRest);
        this._applyNetworkSettings(xhr);
        NativeXHR.prototype.send.call(xhr, body);
      }

      _sendSynthetic(plan, range) {
        const cached = plan?.cachedResponse;
        const buffer = cached?.buffer;
        if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) return false;
        const token = this._requestToken;
        const headers = new Map(Object.entries(cached.headers || {}).map(([name, value]) => [
          String(name).toLowerCase(),
          String(value)
        ]));
        this._synthetic = true;
        this._selected = {
          getAllResponseHeaders() {
            return [...headers].map(([name, value]) => `${name}: ${value}\r\n`).join("");
          },
          getResponseHeader(name) {
            return headers.get(String(name || "").toLowerCase()) || null;
          },
          readyState: 4,
          response: buffer,
          responseText: "",
          responseURL: String(cached.responseURL || ""),
          responseXML: null,
          status: Number(cached.status || 206),
          statusText: String(cached.statusText || "Partial Content")
        };
        this._emit("loadstart", { lengthComputable: true, loaded: 0, total: buffer.byteLength });
        queueMicrotask(() => {
          if (this._settled || this._aborted || token !== this._requestToken) return;
          for (const readyState of [2, 3, 4]) {
            this._readyState = readyState;
            this._emit("readystatechange");
          }
          this._emit("progress", {
            lengthComputable: true,
            loaded: buffer.byteLength,
            total: buffer.byteLength
          });
          this._settled = true;
          this._emit("load");
          this._emit("loadend");
          onCacheHit({
            cacheHosts: Array.isArray(cached.cacheHosts) ? cached.cacheHosts : [],
            context: plan.context,
            expectedBytes: buffer.byteLength,
            range
          });
        });
        return true;
      }

      _waitForPending(plan, range, body) {
        const token = this._requestToken;
        Promise.resolve(plan.pendingResponse).then((resolved) => {
          if (this._settled || this._aborted || token !== this._requestToken) return;
          if (resolved?.cachedResponse && this._sendSynthetic(resolved, range)) return;
          this._sendNetwork(body);
        }).catch(() => {
          if (this._settled || this._aborted || token !== this._requestToken) return;
          this._sendNetwork(body);
        });
        return true;
      }

      send(body = null) {
        if (this._readyState !== 1 || this._sent) throw new DOMException("Invalid state", "InvalidStateError");
        this._sent = true;
        const range = this._headers.find(([name]) => name.toLowerCase() === "range")?.[1] || "";
        let plan = null;
        if (this._async && this._method.toUpperCase() === "GET" && range && this._responseType === "arraybuffer") {
          try {
            plan = resolveCachedRequest({
              headers: [...this._headers],
              method: this._method,
              range,
              responseType: this._responseType,
              url: this._url
            });
          } catch {
            plan = null;
          }
        }
        if (plan?.cachedResponse && this._sendSynthetic(plan, range)) return;
        if (plan?.pendingResponse && this._waitForPending(plan, range, body)) return;
        this._sendNetwork(body);
      }

      abort() {
        if (this._aborted || this._settled) return;
        this._aborted = true;
        this._settled = true;
        this._requestToken += 1;
        if (this._inner) {
          try { rawAbort.call(this._inner); } catch {}
        } else {
          this._readyState = 0;
          this._selected = null;
          this._emit("abort");
          this._emit("loadend");
        }
      }
    }

    for (const [name, value] of [["UNSENT", 0], ["OPENED", 1], ["HEADERS_RECEIVED", 2], ["LOADING", 3], ["DONE", 4]]) {
      Object.defineProperty(CachedXMLHttpRequest, name, { value });
      Object.defineProperty(CachedXMLHttpRequest.prototype, name, { value });
    }
    Object.defineProperty(CachedXMLHttpRequest.prototype, Symbol.toStringTag, { value: "XMLHttpRequest" });
    return CachedXMLHttpRequest;
  }

  root.BiliCdnCachedXHR = Object.freeze({ createCachedXMLHttpRequest });
})(globalThis);

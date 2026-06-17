const DEFAULT_ENDPOINT =
  "https://api.usesapient.com/api/v1/agent-tracking/track";
const TRACKING_TIMEOUT_MS = 2500;

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function getEnv(name) {
  try {
    if (globalThis.Netlify?.env?.get) {
      const value = globalThis.Netlify.env.get(name);
      if (value) return value;
    }
  } catch {
    // Continue to other runtime env APIs.
  }

  try {
    if (globalThis.Deno?.env?.get) {
      const value = globalThis.Deno.env.get(name);
      if (value) return value;
    }
  } catch {
    // Continue to process.env for local smoke tests.
  }

  try {
    if (typeof process !== "undefined" && process.env?.[name]) {
      return process.env[name];
    }
  } catch {
    // No process.env in edge runtimes.
  }

  return undefined;
}

function getOriginUrl() {
  const value = getEnv("ORIGIN_URL");
  if (!value) return undefined;

  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function buildTargetUrl(request, originUrl) {
  try {
    const incoming = new URL(request.url);
    const target = new URL(originUrl);
    const basePath =
      target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");

    target.pathname = `${basePath}${incoming.pathname}`;
    target.search = incoming.search;
    return target;
  } catch {
    return undefined;
  }
}

function isProxyLoop(request, originUrl) {
  try {
    const incoming = new URL(request.url);
    const origin = new URL(originUrl);
    return incoming.host === origin.host;
  } catch {
    return false;
  }
}

function getProxyHeaders(request) {
  const headers = new Headers(request.headers);

  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }

  try {
    const incoming = new URL(request.url);
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  } catch {
    // Keep original forwarding headers if URL parsing fails.
  }

  headers.delete("host");
  return headers;
}

function rewriteRedirectLocation(response, request, originUrl) {
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  if (!location) return headers;

  try {
    const incoming = new URL(request.url);
    const origin = new URL(originUrl);
    const redirectUrl = new URL(location, origin);

    if (redirectUrl.origin === origin.origin) {
      redirectUrl.protocol = incoming.protocol;
      redirectUrl.host = incoming.host;
      headers.set("location", redirectUrl.toString());
    }
  } catch {
    // Keep the origin redirect unchanged if it cannot be parsed.
  }

  return headers;
}

function getCountry(context) {
  try {
    const country = context?.geo?.country;
    if (typeof country === "string") return country || "unknown";
    return country?.code || country?.name || "unknown";
  } catch {
    return "unknown";
  }
}

function getClientIp(request, context) {
  try {
    if (context?.ip) return context.ip;

    const netlifyIp = request.headers.get("x-nf-client-connection-ip");
    if (netlifyIp) return netlifyIp;

    const realIp = request.headers.get("x-real-ip");
    if (realIp) return realIp;

    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      return forwarded.split(",")[0]?.trim() || undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isPageView(accept) {
  try {
    const value = accept.toLowerCase();
    return value.includes("text/html") || value.includes("text/markdown");
  } catch {
    return false;
  }
}

function compactEventBody(body) {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  );
}

async function trackAgentVisit(request, context) {
  const apiKey = getEnv("SAPIENT_API_KEY") || getEnv("SAPIENT_TRACKING_KEY");
  if (!apiKey) return;

  const accept = request.headers.get("accept") || "";
  if (!isPageView(accept)) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // Ignore abort errors.
    }
  }, TRACKING_TIMEOUT_MS);

  try {
    const incoming = new URL(request.url);
    const endpoint = getEnv("SAPIENT_ENDPOINT") || DEFAULT_ENDPOINT;
    const provider = getEnv("SAPIENT_SITE_PROVIDER") || getEnv("SITE_PROVIDER");
    const trackingSource =
      getEnv("SAPIENT_TRACKING_SOURCE") || "netlify_edge_proxy";

    await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(
        compactEventBody({
          host: incoming.hostname || "unknown",
          path: incoming.pathname || "/",
          user_agent: request.headers.get("user-agent") || "",
          accept,
          country: getCountry(context),
          ip_address: getClientIp(request, context),
          tracking_source: trackingSource,
          provider,
        }),
      ),
      signal: controller.signal,
    });
  } catch {
    // Analytics must never affect the proxied page.
  } finally {
    clearTimeout(timeoutId);
  }
}

function runInBackground(context, promise) {
  try {
    if (context?.waitUntil) {
      context.waitUntil(promise);
      return;
    }
  } catch {
    // Fall through to detached promise handling.
  }

  void promise.catch(() => {
    // Analytics must never affect the proxied page.
  });
}

export default async function handler(request, context) {
  const originUrl = getOriginUrl();
  if (!originUrl) {
    return new Response("Missing or invalid ORIGIN_URL", { status: 500 });
  }

  if (isProxyLoop(request, originUrl)) {
    return new Response("ORIGIN_URL must not match the proxy host", {
      status: 508,
    });
  }

  const targetUrl = buildTargetUrl(request, originUrl);
  if (!targetUrl) {
    return new Response("Invalid proxy request URL", { status: 400 });
  }

  let response;
  try {
    response = await fetch(targetUrl, {
      method: request.method,
      headers: getProxyHeaders(request),
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "manual",
    });
  } catch {
    return new Response("Origin unavailable", { status: 502 });
  }

  if (response.status < 500) {
    runInBackground(context, trackAgentVisit(request, context));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: rewriteRedirectLocation(response, request, originUrl),
  });
}

import assert from "node:assert/strict";

import handler from "../netlify/edge-functions/sapient-proxy.js";

function resetEnv() {
  delete process.env.ORIGIN_URL;
  delete process.env.SAPIENT_API_KEY;
  delete process.env.SAPIENT_ENDPOINT;
  delete process.env.SAPIENT_SITE_PROVIDER;
  delete process.env.SITE_PROVIDER;
  delete process.env.SAPIENT_TRACKING_SOURCE;
}

async function testSuccessfulProxyAndTracking() {
  resetEnv();
  process.env.ORIGIN_URL = "https://origin.example/base";
  process.env.SAPIENT_API_KEY = "sap_test";
  process.env.SAPIENT_ENDPOINT = "https://api.example/track";
  process.env.SITE_PROVIDER = "framer";
  process.env.SAPIENT_TRACKING_SOURCE = "netlify_edge_proxy";

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: url.toString(), init });

    if (url.toString().startsWith("https://origin.example")) {
      return new Response("origin ok", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }

    if (url.toString() === "https://api.example/track") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const waitUntil = [];
  const response = await handler(
    new Request("https://agent-test.example.com/docs?q=1", {
      headers: {
        accept: "text/html",
        "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.0)",
      },
    }),
    {
      geo: { country: "US" },
      ip: "203.0.113.10",
      waitUntil: (promise) => waitUntil.push(promise),
    },
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "origin ok");

  await Promise.all(waitUntil);

  assert.equal(calls[0].url, "https://origin.example/base/docs?q=1");
  assert.equal(calls[1].url, "https://api.example/track");

  const trackingBody = JSON.parse(calls[1].init.body);
  assert.equal(trackingBody.host, "agent-test.example.com");
  assert.equal(trackingBody.path, "/docs");
  assert.equal(trackingBody.tracking_source, "netlify_edge_proxy");
  assert.equal(trackingBody.provider, "framer");

  globalThis.fetch = originalFetch;
}

async function testTrackingFailureDoesNotBreakProxy() {
  resetEnv();
  process.env.ORIGIN_URL = "https://origin.example";
  process.env.SAPIENT_API_KEY = "sap_test";
  process.env.SAPIENT_ENDPOINT = "https://api.example/track";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.toString().startsWith("https://origin.example")) {
      return new Response("still ok", { status: 200 });
    }

    throw new Error("tracking unavailable");
  };

  const waitUntil = [];
  const response = await handler(
    new Request("https://agent-test.example.com/", {
      headers: { accept: "text/html" },
    }),
    { waitUntil: (promise) => waitUntil.push(promise) },
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "still ok");
  await Promise.all(waitUntil);

  globalThis.fetch = originalFetch;
}

async function testOriginFailureDoesNotTrack() {
  resetEnv();
  process.env.ORIGIN_URL = "https://origin.example";
  process.env.SAPIENT_API_KEY = "sap_test";
  process.env.SAPIENT_ENDPOINT = "https://api.example/track";

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url.toString());
    throw new Error("origin unavailable");
  };

  const waitUntil = [];
  const response = await handler(
    new Request("https://agent-test.example.com/", {
      headers: { accept: "text/html" },
    }),
    { waitUntil: (promise) => waitUntil.push(promise) },
  );

  assert.equal(response.status, 502);
  assert.equal(calls.length, 1);
  assert.equal(waitUntil.length, 0);

  globalThis.fetch = originalFetch;
}

async function testProxyLoopGuard() {
  resetEnv();
  process.env.ORIGIN_URL = "https://agent-test.example.com";

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("unexpected");
  };

  const response = await handler(
    new Request("https://agent-test.example.com/"),
    {},
  );

  assert.equal(response.status, 508);
  assert.equal(fetchCalled, false);

  globalThis.fetch = originalFetch;
}

await testSuccessfulProxyAndTracking();
await testTrackingFailureDoesNotBreakProxy();
await testOriginFailureDoesNotTrack();
await testProxyLoopGuard();

console.log("Smoke tests passed");

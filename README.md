# Sapient Netlify Proxy Starter

Reverse proxy starter for tracking AI agent visits on Framer or Webflow sites when the custom domain is managed through Netlify DNS.

```text
visitor or agent
  -> Netlify DNS custom domain
  -> Netlify Edge Function
  -> Framer/Webflow origin
  -> Sapient Agent Analytics
```

This is a reverse proxy, not a browser redirect. The visitor stays on your custom domain while Netlify fetches the Framer or Webflow origin behind the scenes.

## Quick Start

1. Deploy this repo as a Netlify site.

   [![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/usesapient/netlify-proxy-starter)

2. Add your test custom domain to the Netlify site, for example:

   ```text
   agent-test.example.com
   ```

3. Set these Netlify environment variables:

   ```bash
   SAPIENT_API_KEY=sap_...
   ORIGIN_URL=https://your-site.framer.website
   SITE_PROVIDER=framer
   SAPIENT_TRACKING_SOURCE=netlify_edge_proxy
   ```

   For Webflow:

   ```bash
   ORIGIN_URL=https://your-site.webflow.io
   SITE_PROVIDER=webflow
   ```

4. Redeploy after changing environment variables.
5. Point the domain at the Netlify site.

## Environment Variables

| Variable | Required | Example | Notes |
| --- | --- | --- | --- |
| `SAPIENT_API_KEY` | Yes | `sap_...` | Agent Analytics tracking key. |
| `ORIGIN_URL` | Yes | `https://your-site.framer.website` | Framer/Webflow platform origin. Do not use your custom domain here. |
| `SITE_PROVIDER` | Recommended | `framer` or `webflow` | Used to segment analytics by platform. |
| `SAPIENT_TRACKING_SOURCE` | Recommended | `netlify_edge_proxy` | Identifies this traffic as Netlify Edge proxy traffic. |

## Netlify DNS Test With An Existing DNS Provider

If your apex domain is currently managed by another DNS provider and you want to test Netlify DNS without moving the whole domain, delegate a subdomain:

1. In Netlify, add a DNS zone or standalone delegated subdomain for:

   ```text
   agent-test.example.com
   ```

2. Netlify will show nameservers for the delegated subdomain.
3. In your current DNS provider, add one `NS` record for each Netlify nameserver:

   ```text
   Type: NS
   Name: agent-test
   Target: <netlify-nameserver>
   ```

4. Add `agent-test.example.com` to this Netlify site under Domain management.
5. Wait for DNS and certificate provisioning.

## Test

```bash
dig NS agent-test.example.com +short
curl -I https://agent-test.example.com/
curl -A "Mozilla/5.0 (compatible; GPTBot/1.0)" \
  -H "Accept: text/html" \
  https://agent-test.example.com/
```

Then check Sapient Agent Analytics for events under `agent-test.example.com`.

## Safety Behavior

Analytics is scheduled in the background with `context.waitUntil()`. If Sapient tracking fails or times out, the proxied page still renders.

The proxy only returns an error response when:

- `ORIGIN_URL` is missing or invalid.
- `ORIGIN_URL` points back to the same host as the proxy, which would create a loop.
- The Framer/Webflow origin cannot be reached.

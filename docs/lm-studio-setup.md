# Local LM Studio Setup

1. Install a current LM Studio release supporting LM Link and native API v1.
2. Start LM Studio and open the Developer page.
3. Start the API server on port `1234`.
4. Leave **Serve on Local Network** disabled. The laboratory only accepts loopback URLs.
5. If API authentication is enabled, create a least-privilege token and set it only in the uncommitted `.env` as `LM_STUDIO_API_TOKEN`.
6. Run `npm run models:lmstudio` and copy the exact GPT-OSS key to `LM_STUDIO_MODEL`.

The HTTP endpoint is `http://127.0.0.1:1234`. Internally, the SDK transport uses `ws://127.0.0.1:1234`; users should configure the HTTP form.

Authentication requires LM Studio 0.4.0 or newer. The published TypeScript SDK does not expose the newer token constructor shown in current documentation, so authenticated requests use LM Studio’s own localhost REST protocol. This does not use an OpenAI account, API key, SDK, model, or hosted service.

These credentials are distinct:

- An **LM Studio API token** authenticates requests to the local API server and is sent only as a Bearer header.
- An **LM Studio account** signs the operator into LM Link; its password is never application configuration.
- **OpenAI API keys are unused**. Do not add one to this laboratory; there is no OpenAI SDK, provider, or fallback.

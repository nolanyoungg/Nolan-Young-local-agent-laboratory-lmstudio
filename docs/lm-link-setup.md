# LM Link Setup Checklist

The repository documents this setup but never logs in, provisions a link, or changes the preferred device.

## Controller machine

- [ ] Install and open current LM Studio.
- [ ] Sign in to the LM Studio account.
- [ ] Enable LM Link and join or create the link.
- [ ] Confirm the desired inference device appears connected.
- [ ] Set the desired inference device as preferred from the LM Link page.
- [ ] Start the local API server on localhost port 1234.
- [ ] Confirm the exact GPT-OSS model key is visible.

## Linked device with the GUI

- [ ] Install LM Studio and sign in to the same account.
- [ ] Enable LM Link.
- [ ] Download the selected GPT-OSS model.
- [ ] Keep LM Studio running and prevent sleep during long workflows.

## Headless linked device

Install `llmster`, then run interactively:

```bash
lms daemon up
lms login
lms link enable
```

Set the desired inference device as preferred from the controller machine or with the interactive `lms link set-preferred-device` command. Never store account credentials or login tokens in this repository.

## Verification

```bash
npm run check:lmstudio
npm run check:lmlink
```

A connected peer or successful response is not proof that inference ran on the preferred linked device. Open LM Studio on the controller machine and observe the active device during the diagnostic request. Preferred linked-device execution requires confirmation in LM Studio.

`check:lmlink` also makes the fixed, read-only advisory calls `lms link status --json` and `lms ps --json` when the optional CLI is available. It never changes preferred-device or link settings.

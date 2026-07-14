# LM Link Setup Checklist

The repository documents this setup but never logs in, provisions a link, or changes the preferred device.

## Windows

- [ ] Install and open current LM Studio.
- [ ] Sign in to the LM Studio account.
- [ ] Enable LM Link and join or create the link.
- [ ] Confirm the Mac appears connected.
- [ ] Set the Mac as the preferred device from the Windows LM Link page.
- [ ] Start the Windows API server on localhost port 1234.
- [ ] Confirm the exact GPT-OSS model key is visible.

## Mac with the GUI

- [ ] Install LM Studio and sign in to the same account.
- [ ] Enable LM Link.
- [ ] Download the selected GPT-OSS model.
- [ ] Keep LM Studio running and prevent sleep during long workflows.

## Headless Mac

Install `llmster`, then run interactively:

```bash
lms daemon up
lms login
lms link enable
```

Set the preferred device from Windows or with the interactive `lms link set-preferred-device` command. Never store account credentials or login tokens in this repository.

## Verification

```bash
npm run check:lmstudio
npm run check:lmlink
```

A connected peer or successful response is not proof that inference ran on the Mac. Open LM Studio on Windows and observe the active device during the diagnostic request. Remote Mac execution requires confirmation in LM Studio.

`check:lmlink` also makes the fixed, read-only advisory calls `lms link status --json` and `lms ps --json` when the optional CLI is available. It never changes preferred-device or link settings.

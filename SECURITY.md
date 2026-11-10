# Security policy

AIB is beta software that runs on your own computer and starts coding agents that can edit files and run commands with your permissions. Please treat it that way.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use this repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting). Include the version (Settings, then Studio server), your operating system, and steps to reproduce. You will get an answer as soon as the maintainer can; this is a one-person project, so please allow some days.

## Scope

In scope: anything that lets a web page, another local user or another program drive AIB without the page token, read files outside a chat's project folder through AIB, escape the same-origin and token checks, or leak credentials, tokens or the state folder.

Out of scope: what an agent does with the permissions you gave it, and problems in the agents' own software (report those to their vendors).

## Design in short

Loopback only; a random per-process page token and same-origin checks on every write; the agent host has its own token and peer check; agents keep their own sign-in; one git worktree per chat. Details are in `outputs/agent-studio/docs/agent-host.md`.

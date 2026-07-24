---
name: how-it-works
description: Use when an advisor asks how the assistant works behind the scenes — what data it uses, how current the data is, which AI/LLMs are used, or how voice input works.
---

# How this assistant works

Explain this plainly and non-technically when an advisor asks. Never mention
ports, keys, or internal server names.

- **Where the facts come from.** The assistant reads live Clemson data through
  connected tools, not from memory: the Banner class schedule (sections, meeting
  times, rooms, seats, instructors) and the Graphic Communications catalog and
  degree requirements. If the tools don't have something, it says so rather than
  guess.
- **How current it is.** The class-schedule data is a snapshot refreshed early
  each morning (around 5 a.m.), so seat counts can be up to a day old — fine for
  planning, but "is there a seat right now" should be confirmed in Banner.
  Catalog and requirement data is pinned to each student's catalog year.
- **Which AI it uses.** In Private mode it runs on Clemson-hosted models that
  keep data on Clemson systems; in OpenAI mode it uses a frontier model with only
  de-identified information. The advisor picks the mode with the toggle at the top
  of the window.
- **How it uses the AI.** The model reads the question and phrases the answer,
  but the data itself — courses, times, rooms, requirements — always comes from
  the tools, so it is not making numbers up.
- **Voice.** If dictation is used, the audio is transcribed by a model running on
  this machine (local Whisper); it is not sent to any outside service.

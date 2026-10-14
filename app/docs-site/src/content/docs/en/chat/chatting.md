---
title: Chatting
sidebar:
  order: 1
---

## Send a message

Type in the **Message the agent…** box, then click **Send** or press **Enter**. **Shift + Enter** starts a new line.

While the agent replies, a status line shows **Thinking…** or **Running a tool…** with a timer. There is one reply at a
time: wait for it to finish (or stop it) before sending the next message.

**Stop:** while the agent replies, the **Send** button becomes **Stop**. Click it to cancel this turn ("Stopped." appears).

![A chat with the agent](../../../../assets/screens/en/chat.png)

## Attaching files

Three ways, in regular and data-analysis chats:

- click the **paperclip** next to **Send**;
- drag files onto the message box;
- paste (Ctrl/Cmd + V) a screenshot or a copied file.

![Two files waiting to be sent](../../../../assets/screens/en/attach-composer.png)

Files upload right away; each is a card with a progress bar. Up to **5 files per message**, **70 MB each**. **Send** waits
until they are uploaded. A failed card has a **Retry** button; **×** takes a file off the message and deletes it (it
was never sent). You can send files without any text.

![A message sent with files](../../../../assets/screens/en/attach-sent.png)

Once sent, the files show above your message: click an image to view it, any other file to download it. The agent reads
the files in the chat's folder with its tools (text, CSV; Python in a data-analysis chat). It does not "see" images the
way you do — it can only process them with code (size, colours…).

- Sending a file with the same name as one already there saves the new one as `name (2).csv`; the old one stays.
- **Files (*n*)** above the message box lists every file of the chat, including the ones the agent made.
- Data Studio does not take files.

## What the agent is doing

Each time the agent uses a tool, a small line appears — click it for the details:

| Line                                   | Meaning                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| Searching… / Searched *n* sources      | The agent searched the web; click to see the sources                            |
| Reading skill … / Read skill …         | The agent is following a [skill](/docs/en/chat/skills/)                         |
| Analyzing data…                        | The agent asked about company data; click for the answer, chart, SQL and table  |
| Using … / Used …                       | Other tools                                                                     |

Answers are shown as Markdown; code blocks have a **Copy** button.

The model is chosen by the system; there is nothing to pick.

## Managing chats

- **Reopen:** click a chat in the sidebar; its whole history (charts and tool results too) comes back. You can carry on
  as usual.
- **Title:** a chat names itself after your first message. To rename it, click the title at the top of the chat, or
  hover the chat in the sidebar → **…** → **Rename** (up to 255 characters; Enter saves, Esc cancels). A title you set
  yourself is never overwritten.
- **Delete:** sidebar → **…** → **Delete**. This cannot be undone — see [Your data](/docs/en/more/data-and-limits/).
- **Sharing a link:** every chat has its own address (`/chat/...`), but **only its owner can open it**.

![A chat's menu](../../../../assets/screens/en/chat-row-menu.png)

## Common errors

| Message                                                          | What to do                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| Lost connection to the agent. Reload the page to continue.       | Reload the page                                               |
| Too many messages: at most 20 per minute…                        | You sent over 20 messages in a minute — wait a moment, resend |
| Model call failed (…)                                            | The model service is failing — try later; if it keeps failing, tell an admin |
| Previous session is no longer available — started a new one      | The old chat was deleted or is gone — use the new chat        |

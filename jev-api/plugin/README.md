# jev-api

Gives Claude three tools that ask TypeSafe's **Jev System One** API one question each about a piece of text: `noul` (yes/no probability), `choice` (pick among named options) and `score` (rate along ordered levels). The tools take text only and use the same endpoint and auth conventions as the Typesafe JS SDK.

## Environment

| Variable                 | Required | Meaning                                                                                                |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `TYPESAFE_API_KEY`       | no       | Bearer token for the TypeSafe API; sent as `Authorization: Bearer ...` only to an https endpoint.      |
| `TYPESAFE_BASE_URL`      | no       | API root, default `https://api.typesafe.ai`; `/v1/systemone` is appended and trailing slashes dropped. |
| `JEV_URL`                | no       | The full System One route; wins over `TYPESAFE_BASE_URL`. A jevfort convention, not an SDK variable.   |
| `TYPESAFE_DEFAULT_MODEL` | no       | Model sent with each request, default `jev-latest`.                                                    |

The three tools are always registered. A call fails locally, without any request, until at least one of `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` or `JEV_URL` is non-blank. The variables are read on every call, so setting one needs no restart. With only `TYPESAFE_API_KEY` set, the default endpoint `https://api.typesafe.ai/v1/systemone` is used.

## Tools

Each tool is registered at session start and called by its full name, `mcp__jev-api__<type>`. Every input is text.

### `mcp__jev-api__noul`

| Input          | Values                                       | Meaning                          |
| -------------- | -------------------------------------------- | -------------------------------- |
| `instructions` | string, required                             | The yes/no question              |
| `state`        | string, required                             | The text the question is about   |
| `criteria`     | object with optional strings `true`, `false` | What counts as true and as false |

Result: `{"type":"noul", ...}` with the answer's probability (0..1).

### `mcp__jev-api__choice`

| Input          | Values                                   | Meaning                        |
| -------------- | ---------------------------------------- | ------------------------------ |
| `instructions` | string, required                         | What to choose                 |
| `state`        | string, required                         | The text the question is about |
| `criteria`     | object, 1 to 255 string values, required | Option name -> description     |

Result: `{"type":"choice","choice":<option>,"confidence":<0..1>,"probabilities":{<option>:<0..1>}}`.

### `mcp__jev-api__score`

| Input          | Values                             | Meaning                                     |
| -------------- | ---------------------------------- | ------------------------------------------- |
| `instructions` | string, required                   | What to rate                                |
| `state`        | string, required                   | The text the question is about              |
| `criteria`     | array of 1 to 10 strings, required | The levels, lowest first; scores start at 0 |

Result: `{"type":"score","score":<level index>,"confidence":<0..1>,"legend":[...],"probabilities":[...]}`.

## Errors

Errors come back as a tool error whose text starts with the tool name.

- No configuration (none of the three variables set): no request is sent.
- Invalid input, or a `JEV_URL` / `TYPESAFE_BASE_URL` that is not an `http(s)` URL: no request is sent.
- HTTP 4xx/5xx: `HTTP <status>` plus the API's `detail` when there is one.
- No answer of the asked type in the response, a network error or an unparsable body: the reason.
- A request taking longer than 30 seconds: `timeout after 30000ms`.

# Hand Tremor Detection

A responsive telemetry dashboard for an FPGA tremor sensor. The interface is a demo and the readings are illustrative, not a medical diagnosis.

## Run the preview

```sh
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The interface shows the browser's local date and live clock; mock dates, report labels, and date-range defaults roll forward automatically when opened and when the day changes. With MySQL running, startup fills a rolling 90-day history at one reading every five minutes (25,920 generated readings) and the app continues to stream a new mock frame every 2.5 seconds. `db/mock-readings.json` contains 1,024 varied frequency, amplitude, and severity templates. The generated mock frames include gradual drift, short-term fluctuations, mild periods, occasional high-risk spikes, current timestamps, and a complete JSON payload. Seeding is repeat-safe, so restarting the app does not duplicate historical frames.

The Reports page loads the available telemetry history, filters it by the selected local date range, updates its trend and average dynamically, and can export all matching records as CSV. The chart downsamples large date ranges for display while retaining the full readings for export.

## Experimental predictions

The Predictions tab fits a multinomial logistic-regression classifier against recent, time-ordered telemetry, reports chronological holdout accuracy, and combines it with a short-horizon trend estimate. Mock-derived predictions are clearly marked experimental and are **not clinically validated, diagnostic, or suitable for care decisions**. Replace the demo labels with appropriately reviewed real-world training/validation data before any research or clinical interpretation.

The Predictions page also includes an optional OpenAI-powered educational chat. Set `OPENAI_API_KEY` in the server environment to enable it; the default model is `gpt-4.1`, and `OPENAI_MODEL` can override that choice. The API key is never sent to the browser. Chat requests send the user's message, a limited recent conversation, and an aggregated summary of up to 12 sensor readings (frequency range, averages, and severity counts) to OpenAI. The telemetry summary contains no patient name or ID, but messages are sent as typed: do not include identifying details. Telemetry is health-related information, so review OpenAI's data policies and obtain any consent required for your deployment before enabling the feature. The assistant is not a clinician and must not be used for diagnosis or treatment decisions. Without a configured key, chat remains disabled and displays that status.

## MySQL storage

Start MySQL with Docker Compose, then run the app with the same credentials configured in `docker-compose.yml`:

```sh
docker compose up -d mysql
npm start
```

The default local database is `tremor_monitor` (`tremor_app` / `dev-app-password`). Override `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, and `MYSQL_PASSWORD` through environment variables for other deployments. The schema is in `db/schema.sql`; readings are indexed by device and timestamp, constrained to severity values 1, 2, or 3, uniquely timestamped per device, and retain the complete incoming/mock frame in a MySQL JSON column.

## FPGA frame interface

The Hardware page can connect to a Web Serial device in a compatible browser. Send newline-delimited JSON frames with `frequency_hz`, `amplitude_mv`, and `severity` (1 = normal, 2 = mild, 3 = high risk), for example:

```json
{"frequency_hz":42.8,"amplitude_mv":1.24,"severity":1}
```

Frames are validated by the API, timestamped when received, persisted to MySQL when configured, and broadcast immediately to connected dashboards over Socket.IO. The adapter is marked as mock until the FPGA frame schema has been verified.

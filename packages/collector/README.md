# @checkpoint/collector

Production verification SDK for Checkpoint v2. The collector runs the same spec used in CI against observed runs out-of-band, persists the result, emits drift events through a pluggable sink, and exports caught failures as regression traces.

Default tests use `InMemoryStore` and do not require a database.

To run Postgres integration tests with Docker:

```bash
docker run --rm --name checkpoint-pg -e POSTGRES_PASSWORD=checkpoint -e POSTGRES_DB=checkpoint -p 54329:5432 -d postgres:16
CHECKPOINT_PG_TEST=1 CHECKPOINT_DATABASE_URL=postgres://postgres:checkpoint@localhost:54329/checkpoint pnpm test
docker stop checkpoint-pg
```

Raw traces are stored as `jsonb` in Postgres for now. S3-compatible object storage offload is intentionally deferred until trace payloads are large enough to justify it.


// Query Cloudflare GraphQL for Worker metrics
const TOKEN = process.env.CF_TOKEN || "CF_TOKEN_PLACEHOLDER";
const ACCOUNT = "CF_ACCOUNT_ID_PLACEHOLDER";
const SCRIPT = "funconnect-v1";

const query = {
  query: `{
    viewer {
      accounts(filter: { accountTag: "${ACCOUNT}" }) {
        workersInvocationsAdaptive(
          filter: {
            scriptName: "${SCRIPT}"
            datetime_geq: "2026-07-09T00:00:00Z"
            datetime_leq: "2026-07-09T23:59:59Z"
          }
          limit: 100
          orderBy: [datetimeMinute_ASC]
        ) {
          sum { requests duration }
          dimensions { datetimeMinute }
        }
      }
    }
  }`,
};

const res = await fetch(
  "https://api.cloudflare.com/client/v4/graphql",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(query),
  }
);

const data = await res.json();
if (data.errors) {
  console.log("GraphQL errors:", JSON.stringify(data.errors, null, 2));
} else {
  const invoc = data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (invoc) {
    const total = invoc.reduce((s, d) => s + (d.sum?.requests || 0), 0);
    const totalDur = invoc.reduce((s, d) => s + (d.sum?.duration || 0), 0);
    console.log(`Total requests today: ${total}`);
    console.log(`Total duration (ms): ${totalDur}`);
    console.log(`Data points: ${invoc.length}`);
    // Show first few
    invoc.slice(0, 5).forEach((d) => {
      console.log(`  ${d.dimensions?.datetimeMinute}: ${d.sum?.requests} req, ${d.sum?.duration}ms`);
    });
  } else {
    console.log("No data returned");
  }
}

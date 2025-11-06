import { connect, StringCodec } from "nats";

const subjects = ["topic.a", "topic.b", "topic.c"];
const sc = StringCodec();

const processMessage = async (msg, subject) => {
  console.log(`Received message on ${subject}: ${sc.decode(msg.data)}`);
  // Simulate async API call
  //await fetch("https://external-api.com/data", { method: "POST" });
};

const main = async () => {
  const nc = await connect({ servers: "nats://localhost:4222" });
  const js = nc.jetstream();

  // Subscribe to all subjects, but process messages in parallel
  const subs = subjects.map(async (subject) => {
    const sub = await js.subscribe(subject, { durable: `consumer-${subject}` });
    (async () => {
      for await (const msg of sub) {
        processMessage(msg, subject)
          .then(() => msg.ack())
          .catch((err) => {
            console.error(`Error processing ${subject}:`, err);
            msg.term();
          });
      }
    })();
  });

  await Promise.all(subs);
};

main();

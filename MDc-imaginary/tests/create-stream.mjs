
import {
    AckPolicy,
    connect,
    millis,
    nuid,
    RetentionPolicy,
  } from "nats";
  
  const servers =  "nats://localhost:4222";
  
  const nc = await connect({
    servers: servers.split(","),
  });
  
  const js = nc.jetstream();
  
  const jsm = await js.jetstreamManager();
  await jsm.streams.add({
    name: "PROCESS",
    retention: RetentionPolicy.Workqueue,
    subjects: ["process.>"],
  });

  console.log("created the 'PROCESS' stream");
  await nc.close()
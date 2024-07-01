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
  
  console.log('adding consumer...')
  
  

  
  try {
    await jsm.consumers.add("PROCESS", {
      durable_name: "md-imaginary",
      ack_policy: AckPolicy.Explicit,
      filter_subject: "process.md-imaginary",
  
    });
  } catch(e) {
      console.log('could not create consumer "md-imaginary')
    console.log(e)
  }
  
  await nc.close()
  
import {
    AckPolicy,
    connect,
    millis,
    nuid,
    RetentionPolicy,
    JSONCodec
  } from "nats";
  
  const jc = JSONCodec();

  const nc = await connect({
    servers: "nats://localhost:4222",
  });
  
  const js = nc.jetstream();  

//   for (var i=0; i<30; i++) {
//     await js.publish("process.thumbnailer", jc.encode({id:i}))
//   }

  var data = {item: 'testi', filepath: 'tests/images/test.png', task: 'rotate', params: {"rotate": 90}}


  //await js.publish("process.md-imaginary", jc.encode(data))
  await js.publish("process.md-imaginary", JSON.stringify(data))

  var data = {item: 'testi', filepath: 'tests/images/test2_faulty.png', task: 'rotate', params: {"rotate": 90}}
  
  await js.publish("process.md-imaginary", JSON.stringify(data))

  await nc.close()
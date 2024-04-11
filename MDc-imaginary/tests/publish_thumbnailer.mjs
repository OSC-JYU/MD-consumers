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



  var data = {
    id: 'thumbnailer',
    task: 'resize',
    params: { width: 200, height: 200, task: 'resize' },
    process: {
      '@rid': '#281:48',
      '@type': 'Process',
      label: 'Rotate',
      _active: true,
      path: 'data/projects/217_10/files/252_236/process/281_48/files'
    },
    file: {
      '@rid': '#252:236',
      '@type': 'File',
      type: 'image',
      extension: 'jpeg',
      label: 'cycling_by_salvador_dali.jpeg',
      _active: true,
      path: 'data/projects/217_10/files/252_236/252_236.jpeg'
    },
    target: '252:236',
    userId: 'local.user@localhost'
  }
  

  //await js.publish("process.md-imaginary", jc.encode(data))
  await js.publish("process.thumbnailer", JSON.stringify(data))


  

  await nc.close()
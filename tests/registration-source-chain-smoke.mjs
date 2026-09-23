import { resolveDescriptorSourceChain } from '../src/funcs.mjs';

const topic = process.env.TOPIC || 'md-hello-world';
const mdUrl = process.env.MD_URL || 'http://localhost:8200';
const adapterName = process.env.ADAPTER || null;
const serviceUrl = process.env.SERVICE_URL || null;

const result = await resolveDescriptorSourceChain({
  topic,
  adapterName,
  mdUrl,
  serviceUrl,
  user: 'local.user@localhost',
});

console.log('source:', result.source);
console.log('id:', result.descriptor?.id);
console.log('tasks:', Object.keys(result.descriptor?.tasks || {}));

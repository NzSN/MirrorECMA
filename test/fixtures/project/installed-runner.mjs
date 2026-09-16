import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {defineSuite, runSuite} from 'mirrorecma';
import {loadProject, doctorProject, checkProject, suiteExitCode} from 'mirrorecma/project';
import {CounterModel} from './generated/Counter.suite.js';

const root=process.cwd();
assert.equal(root,'/tmp/consumer');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const cli=(command,project='mirror.project.json',expected=0)=>{
  const result=spawnSync(resolve('node_modules/.bin/mirrorecma'),[command,...(command==='init'?[project]:['--project',project])],{
    cwd:root,env:process.env,encoding:'utf8',timeout:30_000,maxBuffer:4*1024*1024,
  });
  if(result.error)throw result.error;
  assert.equal(result.status,expected,`${command} ${project}: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim() || result.stderr.trim());
};
for(const repository of JSON.parse(process.env.SUITE_HIDDEN_ROOTS))assert(!existsSync(join(repository,'package.json'))&&!existsSync(join(repository,'lakefile.lean')));
assert(!existsSync(process.env.SUITE_ORIGINAL_INSTALL),'original consumer must be absent');
for(const compilerPath of ['/usr/local/lib/node_modules/typescript/lib/tsc.js','/usr/share/nodejs/typescript/lib/tsc.js','/usr/local/lib/node_modules/npm/bin/npm-cli.js'])assert(!existsSync(compilerPath),'host build/install tooling must be hidden');
const preparation=JSON.parse(readFileSync('preparation-audit.json','utf8'));
for(const key of ['packageBuilds','applicationCompiles','packs','installs'])assert.equal(preparation[key],1);
await assert.rejects(import('mirrorgate'),{code:'ERR_MODULE_NOT_FOUND'});
await assert.rejects(import('mirrorgate-mirrorecma'),{code:'ERR_MODULE_NOT_FOUND'});
assert.deepEqual(readdirSync('node_modules').filter(name=>name!=='mirrorecma'&&name!=='.package-lock.json'&&name!=='.bin'),[]);

const lifecycle=()=>existsSync('lifecycle.log')?readFileSync('lifecycle.log','utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const marker=()=>existsSync('adapter-imports.log')?readFileSync('adapter-imports.log','utf8'):'';
const before=marker();
const loaded=await loadProject(new URL('./mirror.project.json',import.meta.url),{requiredTools:['compiler','server']});
assert.equal(loaded.declaration.model.source,join(root,'specs/Counter.tla'));
assert.equal(loaded.replay.modelSource,join(root,'specs/Counter.tla'));
assert.equal(loaded.execution.mirror,join(root,'tools/mirror'));
assert.equal(marker(),before,'loadProject must not import adapter');
const doctor=await doctorProject('mirror.project.json');
assert(!doctor.some(check=>check.status==='failed'),JSON.stringify(doctor));
await checkProject('mirror.project.json');
cli('check');cli('doctor');
assert.equal(marker(),before,'doctor/check must not import adapter');
const seeded=cli('init',`seeded-${process.argv[2]}`);
assert.equal(seeded.created.length,3);
assert.deepEqual(cli('init',`seeded-${process.argv[2]}`).created,[],'init preserves declarations');

const lifecycleBefore=lifecycle().length;
const good=cli('replay');
assert.equal(good.outcome,'passed');assert.equal(good.conformance,'matched');assert.equal(good.acceptance.status,'met');
assert.equal(good.evidence.transitionsMatched,'2');assert.equal(good.cleanup.status,'succeeded');assert.equal(good.cleanup.quiescence,'confirmed');
assert.equal(suiteExitCode(good),0);assert.equal(marker().length,before.length+'correct\n'.length);
assert.equal(good.project.modelModuleSha256,hash('generated/Counter.suite.js'));
assert.deepEqual(lifecycle().slice(lifecycleBefore),[{variant:'correct',event:'factory'},{variant:'correct',event:'dispose'}]);
const repeatBefore=lifecycle().length;const repeated=cli('replay','repeat.project.json');
assert.equal(repeated.outcome,'passed');assert.equal(repeated.evidence.initializationsMatched,'2');assert.equal(repeated.evidence.transitionsMatched,'4');assert.equal(repeated.evidence.pairCounts['[\"Tick\",\"Tick\"]'],'2');
assert.deepEqual(lifecycle().slice(repeatBefore),[{variant:'correct',event:'factory'},{variant:'correct',event:'dispose'}]);
const cases=[];
for(const [name,exit,outcome,kind] of [
  ['faulty',1,'mismatch','mismatch'],
  ['coverage',2,'failed','acceptance'],
  ['malformed',2,'failed','implementation'],
  ['dispose-failure',2,'failed','cleanup'],
  ['hang',2,'timedOut','timeout'],
]){
  const result=cli('replay',`${name}.project.json`,exit);
  assert.equal(result.outcome,outcome,JSON.stringify(result));
  assert.equal(result.failure.kind,kind,JSON.stringify(result));
  assert.equal(suiteExitCode(result),exit);
  if(name==='faulty')assert.deepEqual([result.failure.traceIndex,result.failure.stateIndex],[0,1]);
  if(name==='coverage'){assert.equal(result.conformance,'matched');assert.equal(result.acceptance.status,'unmet');assert.equal(result.failure.code,'coverage_unmet');}
  if(name==='hang')assert.equal(result.cleanup.quiescence,'unconfirmed');
  cases.push({name,outcome,exit,cleanup:result.cleanup.status});
}
assert(existsSync('malformed-cleanup.log'),'malformed returned adapter must dispose its allocation');
const malformedCalls=readFileSync('malformed-cleanup.log','utf8').trim().split('\n').length;
assert.equal(malformedCalls,Number(process.argv[2])+1,'malformed adapter has one transferred/partial cleanup');

const project=JSON.parse(readFileSync('mirror.project.json','utf8'));
const suite=defineSuite({id:project.suiteId,model:CounterModel,replay:{...loaded.replay},acceptance:project.acceptance});
let deniedFactory=0,deniedClose=0;
const denied=await runSuite(suite,{mirror:{send(){},async close(){deniedClose++;return 0;},async *[Symbol.asyncIterator](){yield JSON.stringify({proto_step:'spec_validated',result:'valid',modelInterface:{schema:'mirrors.model-interface-negotiation/v1',status:'matched',descriptorSchema:'mirrors.model-interface-descriptor/v1',semanticDigest:`sha256:${'0'.repeat(64)}`}});}},implementation:async()=>{deniedFactory++;return (await import('./denied-adapter.mjs')).createAdapter();}});
assert.equal(denied.outcome,'failed');assert.equal(denied.acceptance.status,'not_evaluated');assert.equal(deniedFactory,0);assert.equal(deniedClose,1);assert(!existsSync('denied-import.log'));

const descriptorPath='generated/descriptor.json';
const clean=readFileSync(descriptorPath);writeFileSync(descriptorPath,Buffer.concat([clean,Buffer.from(' ')]));
const stale=readFileSync(descriptorPath);cli('check','mirror.project.json',2);assert.deepEqual(readFileSync(descriptorPath),stale,'check must not repair stale files');writeFileSync(descriptorPath,clean);
const noImportBefore=marker();
const missing={...project,replay:{...project.replay,traces:['traces/absent.itf.json']}};
writeFileSync('missing.project.json',JSON.stringify(missing));cli('replay','missing.project.json',2);assert.equal(marker(),noImportBefore);
assert(!existsSync('forbidden-tool.log'),'execution must never rebuild/install/fetch');
const compilerCommands=readFileSync('compiler-commands.log','utf8').trim().split('\n');
assert.equal(compilerCommands.filter(command=>command==='prepare:resolve').length,1);
assert.equal(compilerCommands.filter(command=>command==='prepare:bundle').length,1);
assert(compilerCommands.filter(command=>command.startsWith('replay:')).every(command=>['replay:check-bundle','replay:preflight'].includes(command)));
assert.equal(hash('tools/compiler.bin'),preparation.compilerSha256);
const report={schema:'mirrorecma.installed-suite-evidence/v1',iteration:Number(process.argv[2]),preparation:{packageBuilds:preparation.packageBuilds,packs:preparation.packs,installs:preparation.installs,bundleGenerations:compilerCommands.filter(command=>command==='prepare:bundle').length,applicationCompiles:preparation.applicationCompiles},identities:{packageSha256:process.env.SUITE_PACKAGE_SHA256,compilerSha256:preparation.compilerSha256,compilerLauncherSha256:loaded.tools.compiler.sha256,serverSha256:loaded.tools.server.sha256,...good.identities,modelModuleSha256:good.project.modelModuleSha256},isolation:{network:'unshared',frameworkCheckouts:'hidden',relocated:true,packages:['mirrorecma'],implicitBuilds:false},correct:{outcome:good.outcome,matchedTransitions:good.evidence.transitionsMatched,cleanup:good.cleanup},cases,denied:{outcome:denied.outcome,factoryCalls:deniedFactory},checks:['one-factory-and-disposer-for-repeated-traces','init','loadProject','doctor','check','read-only-freshness','missing-corpus','prepared-module-hash']};
appendFileSync('installed-evidence.jsonl',JSON.stringify(report)+'\n');
console.log(JSON.stringify(report));

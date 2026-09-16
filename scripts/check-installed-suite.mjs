// Prepare once, move the installation, then execute only public package APIs
// twice with no network and all framework source checkouts hidden.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const mirrors=resolve(process.env.MIRRORS_ROOT??join(root,'../Mirrors'));
const gate=resolve(process.env.MIRRORGATE_ROOT??join(root,'../MirrorGate'));
const compiler=resolve(process.env.MODEL_INTERFACE_GEN??join(mirrors,'.lake/build/bin/model_interface_gen'));
const mirror=resolve(process.env.MIRROR_BIN??join(mirrors,'.lake/build/bin/mirror'));
for(const binary of [compiler,mirror])assert(existsSync(binary),`prepare required trusted executable: ${binary}`);
const scratch=mkdtempSync(join(tmpdir(),'mirrorecma-installed-suite-'));
const preparationCommands=[];
const run=(command,args,cwd=scratch,env=process.env)=>{
  const result=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:120_000,maxBuffer:16*1024*1024});
  if(result.error)throw result.error;
  assert.equal(result.status,0,`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  preparationCommands.push({command,args:[...args]});
  return result.stdout.trim();
};
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
try{
  // Build the package once without cleaning dist during concurrent public SDK checks.
  run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',join(root,'tsconfig.json')],root);
  const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',scratch,'--cache',join(scratch,'npm-cache')],root))[0];
  const original=join(scratch,'prepared');mkdirSync(original);
  json(join(original,'package.json'),{name:'independent-application',private:true,type:'module'});
  run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--cache',join(scratch,'npm-cache'),join(scratch,packed.filename)],original);
  const packageJson=JSON.parse(readFileSync(join(original,'node_modules/mirrorecma/package.json')));
  assert.equal(packageJson.name,'mirrorecma');
  for(const field of ['dependencies','optionalDependencies','peerDependencies'])assert.deepEqual(Object.keys(packageJson[field]??{}),[]);
  for(const folder of ['specs','traces','tools','generated','.mirrors','no-tools'])mkdirSync(join(original,folder));
  copyFileSync(compiler,join(original,'tools/compiler.bin'));chmodSync(join(original,'tools/compiler.bin'),0o700);
  const compilerSha256=sha(join(original,'tools/compiler.bin'));
  // The configured executable identity pins both this audited launcher and its
  // copied native compiler hash. Runtime permits only read-only compiler modes.
  writeFileSync(join(original,'tools/model_interface_gen'),`#!/bin/sh
set -eu
suite_tools_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
suite_compiler_digest=$(sha256sum "$suite_tools_dir/compiler.bin")
case "$suite_compiler_digest" in '${compilerSha256} '*) ;; *) exit 96 ;; esac
printf '%s:%s\\n' "\${SUITE_EXECUTION_PHASE:-prepare}" "$1" >> "$suite_tools_dir/../compiler-commands.log"
if [ "\${SUITE_EXECUTION_PHASE:-prepare}" = replay ]; then
  case "$1" in check-bundle|preflight) ;; *) printf '%s\\n' "compiler:$1" >> "$suite_tools_dir/../forbidden-tool.log"; exit 97 ;; esac
fi
exec "$suite_tools_dir/compiler.bin" "$@"
`);chmodSync(join(original,'tools/model_interface_gen'),0o700);
  copyFileSync(mirror,join(original,'tools/mirror'));chmodSync(join(original,'tools/mirror'),0o700);
  copyFileSync(join(root,'examples/generated-counter/specs/Counter.tla'),join(original,'specs/Counter.tla'));
  copyFileSync(join(root,'test/fixtures/model-interface/counter/Counter.mirror-interface.json'),join(original,'specs/Counter.mirror-interface.json'));
  copyFileSync(join(root,'test/fixtures/model-interface/counter/counter.itf.json'),join(original,'traces/counter.itf.json'));
  const short=JSON.parse(readFileSync(join(original,'traces/counter.itf.json')));short.states.pop();json(join(original,'traces/short.itf.json'),short);
  const toolchain={schema:'mirrorecma.toolchain/v1',tools:{
    compiler:{path:'tools/model_interface_gen',sha256:sha(join(original,'tools/model_interface_gen')),version:'model-interface-gen/1',capabilities:['bundle-v1','check-bundle-v1','preflight-v1']},
    server:{path:'tools/mirror',sha256:sha(join(original,'tools/mirror')),version:'installed-checkout',capabilities:['model-interface-v1','checked-replay-v1']},
  }};
  json(join(original,'mirror.toolchain.json'),toolchain);
  const project={schema:'mirrorecma.project/v1',suiteId:'installed-counter/v1',model:{source:'specs/Counter.tla',contract:'specs/Counter.mirror-interface.json',evidence:'traces/counter.itf.json',lock:'.mirrors/Counter.mirror-interface.lock.json',target:'mirrorecma-async-v1',generatedDirectory:'generated',module:'generated/Counter.suite.js',export:'CounterModel'},implementation:{module:'adapter.mjs',export:'createAdapter'},replay:{kind:'corpus',config:{specPath:'specs/Counter.tla',constInit:'CInit',invariant:'TraceComplete',lengthBound:6,paramVars:'parameters'},traces:[{path:'traces/counter.itf.json',sha256:sha(join(original,'traces/counter.itf.json'))}]},acceptance:{requiredActions:['Tick'],requiredPairs:[['Tick','Tick']]},execution:{mirror:{kind:'local'},timeouts:{registrationMs:10000,actionMs:1000,receiveMs:10000,cleanupMs:200}},toolchainLock:'mirror.toolchain.json'};
  json(join(original,'mirror.project.json'),project);
  run(join(original,'node_modules/.bin/mirrorecma'),['generate','--project','mirror.project.json'],original);
  // Application preparation compiles the generated evaluator once. Runtime has no TS compiler.
  run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'generated/Counter.suite.ts','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck','--types','node','--typeRoots',join(root,'node_modules/@types')],original);
  project.model.moduleSha256=sha(join(original,'generated/Counter.suite.js'));
  const lock=JSON.parse(readFileSync(join(original,'.mirrors/Counter.mirror-interface.lock.json')));
  project.replay.provenance={interfaceDigest:lock.semanticDigest,modelSha256:sha(join(original,'specs/Counter.tla'))};
  json(join(original,'mirror.project.json'),project);
  const createAdapter=(variant)=>`import {appendFileSync} from 'node:fs';
appendFileSync('adapter-imports.log',${JSON.stringify(variant+'\n')});
export function createAdapter(){appendFileSync('lifecycle.log',JSON.stringify({variant:${JSON.stringify(variant)},event:'factory'})+'\\n');let count=0n;return {actions:{Initialize:()=>{count=0n;},Tick:({Stride})=>{${variant==='hang'?'return new Promise(()=>{});':`count+=Stride${variant==='faulty'?'-1n':''};`}}},observe:()=>({Count:count}),dispose:()=>{appendFileSync('lifecycle.log',JSON.stringify({variant:${JSON.stringify(variant)},event:'dispose'})+'\\n');${variant==='dispose-failure'?'throw new Error("intentional cleanup failure");':''}}};}
`;
  writeFileSync(join(original,'adapter.mjs'),createAdapter('correct'));
  for(const variant of ['faulty','dispose-failure','hang']){
    writeFileSync(join(original,`${variant}-adapter.mjs`),createAdapter(variant));
    json(join(original,`${variant}.project.json`),{...project,implementation:{module:`${variant}-adapter.mjs`,export:'createAdapter'},...(variant==='hang'?{execution:{...project.execution,timeouts:{...project.execution.timeouts,actionMs:30,cleanupMs:50}}}:{})});
  }
  json(join(original,'repeat.project.json'),{...project,replay:{...project.replay,traces:[...project.replay.traces,...project.replay.traces]}});
  json(join(original,'coverage.project.json'),{...project,replay:{...project.replay,traces:[{path:'traces/short.itf.json',sha256:sha(join(original,'traces/short.itf.json'))}]}});
  writeFileSync(join(original,'malformed-adapter.mjs'),`import {appendFileSync} from 'node:fs'; export function createAdapter(){return {observe:null,dispose(){appendFileSync('malformed-cleanup.log','disposed\\n');}};}\n`);
  json(join(original,'malformed.project.json'),{...project,implementation:{module:'malformed-adapter.mjs',export:'createAdapter'}});
  writeFileSync(join(original,'denied-adapter.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync('denied-import.log','imported');export function createAdapter(){throw new Error('denied adapter must not import');}\n`);
  for(const command of ['npm','pnpm','npx','tsc','lake','git','make','java','apalache-mc']){
    const sentinel=join(original,'no-tools',command);writeFileSync(sentinel,`#!/bin/sh\nprintf '%s\\n' '${command}' >> /tmp/consumer/forbidden-tool.log\nexit 97\n`);chmodSync(sentinel,0o700);
  }
  copyFileSync(join(root,'test/fixtures/project/installed-runner.mjs'),join(original,'run.mjs'));
  json(join(original,'preparation-audit.json'),{
    commands:preparationCommands,
    packageBuilds:preparationCommands.filter(entry=>entry.args[0]===join(root,'node_modules/typescript/bin/tsc')&&entry.args[1]==='-p').length,
    applicationCompiles:preparationCommands.filter(entry=>entry.args[0]===join(root,'node_modules/typescript/bin/tsc')&&entry.args[1]==='generated/Counter.suite.ts').length,
    packs:preparationCommands.filter(entry=>basename(entry.command)==='npm'&&entry.args[0]==='pack').length,
    installs:preparationCommands.filter(entry=>basename(entry.command)==='npm'&&entry.args[0]==='install').length,
    compilerSha256,
  });
  const relocated=join(scratch,'relocated');renameSync(original,relocated);
  const env={...process.env,NODE_PATH:'',npm_config_offline:'true',PATH:'/tmp/consumer/no-tools:/usr/local/bin:/usr/bin:/bin',SUITE_HIDDEN_ROOTS:JSON.stringify([root,mirrors,gate]),SUITE_ORIGINAL_INSTALL:original,SUITE_PACKAGE_SHA256:sha(join(scratch,packed.filename)),SUITE_EXECUTION_PHASE:'replay'};
  for(const name of ['MIRRORS_ROOT','MIRROR_BIN','MODEL_INTERFACE_GEN','MIRRORECMA_ROOT','MIRRORGATE_ROOT','NODE_OPTIONS'])delete env[name];
  for(let iteration=0;iteration<2;iteration++){
    const args=['--die-with-parent','--unshare-net','--ro-bind','/','/','--dev-bind','/dev','/dev','--proc','/proc','--tmpfs','/tmp'];
    // Hide user caches/toolchains and common global Node module installations,
    // including absolute-path TypeScript/npm entry points, before execution.
    for(const hidden of ['/home','/root','/usr/local/lib/node_modules','/usr/lib/node_modules','/usr/share/nodejs'])if(existsSync(hidden))args.push('--tmpfs',hidden);
    for(const repository of [root,mirrors,gate])args.push('--tmpfs',repository);
    args.push('--bind',relocated,'/tmp/consumer','--chdir','/tmp/consumer','--',process.execPath,'run.mjs',String(iteration));
    console.log(run('bwrap',args,relocated,env));
  }
  const evidence=readFileSync(join(relocated,'installed-evidence.jsonl'),'utf8');
  if(process.env.SUITE_EVIDENCE_OUT)writeFileSync(resolve(process.env.SUITE_EVIDENCE_OUT),evidence);
  console.log('INSTALLED LOCAL SUITE GREEN: prepared once, relocated, offline, no Gate packages, hidden framework checkouts, repeated public CLI/library replay');
}finally{
  if(process.env.KEEP_SUITE_CONSUMER==='1')console.log(`installed suite retained: ${scratch}`);
  else rmSync(scratch,{recursive:true,force:true});
}

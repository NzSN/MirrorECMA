#!/usr/bin/env node
import { checkProject, doctorProject, generateProject, initProject, replayProject, suiteExitCode, projectFailure, ProjectError, type ProjectStage, type ProjectCommandOptions } from "./project.js";

const usage="Usage: mirrorecma init [DIRECTORY] | doctor|generate|check|replay [--project FILE] [--compiler FILE] [--server FILE] [--tool-registry FILE]";
let stage:ProjectStage="configuration";
async function main(args:string[]):Promise<number> {
  const command=args.shift();
  if(command==="--help"||command==="-h"){console.log(usage);return 0;}
  if(command==="init") {if(args.length>1||args[0]?.startsWith("--"))throw new ProjectError("usage",usage);console.log(JSON.stringify({created:await initProject(args[0]??".")}));return 0;}
  if(!command||!["doctor","generate","check","replay"].includes(command))throw new ProjectError("usage",usage);
  const flags:Record<string,string>=Object.create(null);
  for(let i=0;i<args.length;i+=2){const k=args[i]!;if(!["--project","--compiler","--server","--tool-registry"].includes(k)||Object.hasOwn(flags,k)||!args[i+1]||args[i+1]!.startsWith("--"))throw new ProjectError("usage",usage);flags[k]=args[i+1]!;}
  const file=flags["--project"]??"mirror.project.json";
  const controller=new AbortController();
  const stop=()=>controller.abort("CLI interrupted");process.once("SIGINT",stop);process.once("SIGTERM",stop);
  const options:ProjectCommandOptions={signal:controller.signal,installedRegistry:flags["--tool-registry"],tools:{...(flags["--compiler"]?{compiler:flags["--compiler"]}:{}),...(flags["--server"]?{server:flags["--server"]}:{})}};
  try {
    if(command==="doctor"){const checks=await doctorProject(file,options);console.log(JSON.stringify({checks},null,2));return checks.some(c=>c.status==="failed")?2:0;}
    if(command==="generate"){stage="generation";await generateProject(file,options);console.log(JSON.stringify({status:"generated"}));return 0;}
    if(command==="check"){stage="check";await checkProject(file,options);console.log(JSON.stringify({status:"checked"}));return 0;}
    stage="replay";
    const result=await replayProject(file,options);console.log(JSON.stringify(result,null,2));return suiteExitCode(result);
  } finally {process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
}
main(process.argv.slice(2)).then(code=>{process.exitCode=code;},error=>{
  console.error(JSON.stringify(projectFailure(error,stage)));process.exitCode=2;
});

import cp from 'child_process';
import fs from 'fs';
const out = cp.execSync('npx -y oxlint client/src shared server_bun/src',{encoding:'utf8',stdio:['pipe','pipe','ignore']});
const names = [...new Set([...out.matchAll(/'([^']+)' was used before it was defined/g)].map(m=>m[1]))];
let fn=0,cn=0,cl=0,oth=0;
for(const n of names){
  let r='';
  try{r=cp.execSync(`grep -rln "${n}" client/src shared server_bun/src`,{encoding:'utf8'}).trim().split('\n')[0];}catch{}
  if(!r){oth++;continue;}
  let line='';
  try{line=cp.execSync(`grep -nE "(export )?(async )?(function|const|let|class|interface|type|enum) +${n}[ <(:=]" ${r}`,{encoding:'utf8'}).trim().split('\n')[0];}catch{}
  if(/\bfunction\b/.test(line))fn++;else if(/\b(const|let)\b/.test(line))cn++;else if(/\bclass\b/.test(line))cl++;else oth++;
}
console.log(JSON.stringify({fn,cn,cl,oth,total:names.length}));

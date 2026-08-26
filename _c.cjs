const fs=require('fs');
const {execSync}=require('child_process');
try{
  execSync('node --check _extracted.js',{stdio:'pipe'});
  fs.writeFileSync('_result.txt','SYNTAX OK');
}catch(e){
  fs.writeFileSync('_result.txt','ERROR: '+e.stderr.toString().slice(0,500));
}

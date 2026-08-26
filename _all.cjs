const fs=require('fs');
const files=['assets/index.html','assets/login.html','assets/conversation.html','assets/debug.html'];
for(const f of files){
  const html=fs.readFileSync(f,'utf8');
  const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  console.log('\n== '+f+' ==');
  console.log('  file size:',html.length,'bytes');
  console.log('  script blocks:',scripts.length);
  scripts.forEach((m,i)=>{
    const content=m[1];
    const tmp='_chk_'+i+'.js';
    fs.writeFileSync(tmp,content);
    try{
      require('child_process').execSync('node --check "'+tmp+'"',{stdio:'pipe'});
      console.log('  script['+i+'] ('+content.length+' chars): SYNTAX OK');
    }catch(e){
      const err=e.stderr?e.stderr.toString():e.message;
      console.log('  script['+i+'] ('+content.length+' chars): SYNTAX ERROR');
      console.log('    '+err.slice(0,200));
    }
    fs.unlinkSync(tmp);
  });
  // ?? HTML ????
  const opens=(html.match(/<div[\s>]/g)||[]).length;
  const closes=(html.match(/<\/div>/g)||[]).length;
  if(opens!==closes)console.log('  WARNING: div open='+opens+' close='+closes);
}

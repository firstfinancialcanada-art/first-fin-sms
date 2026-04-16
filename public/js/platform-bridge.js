(function(){
  var BRIDGE='http://localhost:5001';
  var dtContacts=[];
  var dtCRMCount=0;
  var dtLogCount=0;
  var dtPollTimer=null;
  var dtOnline=false;

  function dtLog(msg){
    var box=document.getElementById('dt-log');
    if(!box)return;
    var d=document.createElement('div');
    d.className='dt-log-line'+(msg.indexOf('Error')>-1||msg.indexOf('Error')>-1?' err':msg.indexOf('Saved')>-1||msg.indexOf('Success')>-1?' ok':'');
    d.textContent=msg;
    box.appendChild(d);
    box.scrollTop=box.scrollHeight;
  }

  function dtSetDot(color,label){
    var dot=document.getElementById('dt-dot');
    var lbl=document.getElementById('dt-bridge-label');
    if(dot)dot.className='dt-dot '+color;
    if(lbl)lbl.textContent=label;
  }

  async function dtPing(){
    try{
      var r=await fetch(BRIDGE+'/ping',{signal:AbortSignal.timeout(2000)});
      var d=await r.json();
      if(d.ok){
        dtOnline=true;
        dtSetDot('green','Bridge connected — ready');
        document.getElementById('dt-btn-start').disabled=false;
        // Check for saved progress to enable Resume
        try{
          var pr=await fetch(BRIDGE+'/progress',{signal:AbortSignal.timeout(2000)});
          var pd=await pr.json();
          document.getElementById('dt-btn-resume').disabled=!pd.has_progress;
          if(pd.has_progress){
            dtSetDot('green','Bridge connected — can resume from row '+pd.last_row);
          }
        }catch(e){}
        var sb=document.getElementById('dt-setup-box');
        if(sb)sb.style.display='none';
      }
    }catch(e){
      dtOnline=false;
      dtSetDot('red','Bridge offline — run dealertrack_scraper.py first');
      document.getElementById('dt-btn-start').disabled=true;
      document.getElementById('dt-btn-resume').disabled=true;
    }
  }

  var dtReconnectAttempts=0;

  async function dtPoll(){
    if(!dtOnline){
      // Auto-reconnect attempt every poll cycle
      dtReconnectAttempts++;
      if(dtReconnectAttempts%3===0) dtPing(); // try every ~6 seconds
      return;
    }
    try{
      var sr=await fetch(BRIDGE+'/status',{signal:AbortSignal.timeout(3000)});
      var s=await sr.json();
      dtReconnectAttempts=0; // reset on success

      var pct=s.total_rows>0?Math.round((s.current_row/s.total_rows)*100):0;
      document.getElementById('dt-prog-fill').style.width=pct+'%';
      document.getElementById('dt-prog-pct').textContent=pct+'%';
      document.getElementById('dt-prog-label').textContent=s.total_rows>0?'Row '+s.current_row+' of '+s.total_rows:'Waiting...';
      document.getElementById('dt-prog-msg').textContent=s.status_msg||'';

      // Correct counts from backend
      var contacts=s.total_saved||0;
      var dealsProcessed=s.deals_processed||s.current_row||0;
      var dealsSkipped=s.deals_skipped||0;
      var remaining=s.total_rows>0?(s.total_rows-(s.current_row||0)):0;

      document.getElementById('dt-s-total').textContent=contacts;
      document.getElementById('dt-s-deals').textContent=dealsProcessed;
      document.getElementById('dt-s-skipped').textContent=dealsSkipped;
      document.getElementById('dt-s-remain').textContent=s.total_rows>0?remaining:'—';

      // Button states
      document.getElementById('dt-btn-start').disabled=s.running;
      document.getElementById('dt-btn-stop').disabled=!s.running;
      document.getElementById('dt-btn-resume').disabled=s.running; // can't resume while running

      if(s.running){
        dtSetDot('yellow','Running — Deal #'+(s.current_deal||'...')+' (row '+s.current_row+'/'+s.total_rows+')');
      } else if(contacts>0){
        dtSetDot('green','Done — '+contacts+' contacts from '+dealsProcessed+' deals ('+dealsSkipped+' skipped)');
      }

      // Log sync — only append new lines, with DOM size limit
      if(s.log&&s.log.length>dtLogCount){
        var box=document.getElementById('dt-log');
        var newLines=s.log.slice(dtLogCount);
        newLines.forEach(function(l){
          var d=document.createElement('div');
          d.className='dt-log-line'+(l.indexOf('Error')>-1||l.indexOf('error')>-1||l.indexOf('Could not')>-1?' err':l.indexOf('Saved')>-1||l.indexOf('contacts')>-1||l.indexOf('Found')>-1?' ok':'');
          d.textContent=l;
          box.appendChild(d);
        });
        // Cap DOM nodes to prevent freeze — keep last 200 lines
        while(box.children.length>200){box.removeChild(box.firstChild);}
        box.scrollTop=box.scrollHeight;
        dtLogCount=s.log.length;
      }

      // Contact feed
      var cr=await fetch(BRIDGE+'/contacts',{signal:AbortSignal.timeout(3000)});
      var contactList=await cr.json();
      if(contactList.length>dtContacts.length){
        var newOnes=contactList.slice(dtContacts.length);
        dtContacts=contactList;
        newOnes.forEach(function(c){
          var empty=document.getElementById('dt-feed-empty');
          if(empty)empty.remove();
          var feed=document.getElementById('dt-feed');
          var row=document.createElement('div');
          row.className='dt-feed-row';
          var name=((c.first_name||'')+' '+(c.last_name||'')).trim()||'Unknown';
          var phone=c.mobile_phone||c.phone||'—';
          var email=c.email||'—';
          var isCo=c.applicant_type==='CO-APPLICANT';
          // Build DOM with textContent — name/phone/email come from external
          // bridge data (potentially attacker-controlled) and MUST NOT be
          // interpolated into innerHTML.
          var info=document.createElement('div');
          var nameEl=document.createElement('div'); nameEl.className='dt-feed-name'; nameEl.textContent=name;
          var phoneEl=document.createElement('div'); phoneEl.className='dt-feed-detail'; phoneEl.textContent=phone;
          var emailEl=document.createElement('div'); emailEl.className='dt-feed-detail'; emailEl.textContent=email;
          info.appendChild(nameEl); info.appendChild(phoneEl); info.appendChild(emailEl);
          var badge=document.createElement('span');
          badge.className='dt-badge-src'+(isCo?' dt-badge-co':'');
          badge.textContent=isCo?'CO':'PRIMARY';
          row.appendChild(info); row.appendChild(badge);
          feed.prepend(row);
          // Cap feed DOM too
          while(feed.children.length>150){feed.removeChild(feed.lastChild);}
        });
        document.getElementById('dt-btn-crm').disabled=(dtContacts.length===0);
      }
    }catch(e){
      dtOnline=false;
      dtSetDot('red','Bridge connection lost — reconnecting...');
      // Don't blank everything — just flag offline and let reconnect kick in
    }
  }

  window.dtStart=async function(){
    try{
      dtLogCount=0;
      document.getElementById('dt-log').innerHTML='';
      document.getElementById('dt-s-skipped').textContent='0';
      var r=await fetch(BRIDGE+'/start',{method:'POST'});
      var d=await r.json();
      if(!d.ok)alert(d.msg);
    }catch(e){alert('Could not reach bridge. Make sure dealertrack_scraper.py is running.');}
  };

  window.dtStop=async function(){
    try{await fetch(BRIDGE+'/stop',{method:'POST'});}catch(e){}
  };

  window.dtResume=async function(){
    try{
      var r=await fetch(BRIDGE+'/resume',{method:'POST'});
      var d=await r.json();
      if(d.ok){
        dtSetDot('yellow','Resuming from saved progress...');
      } else {
        alert(d.msg || 'Cannot resume — no saved progress found. Use Start instead.');
      }
    }catch(e){alert('Could not reach bridge.');}
  };

  window.dtClear=async function(){
    if(!confirm('Clear all captured contacts?'))return;
    try{
      await fetch(BRIDGE+'/clear',{method:'POST'});
      dtContacts=[];dtLogCount=0;dtCRMCount=0;
      document.getElementById('dt-feed').innerHTML='<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px;" id="dt-feed-empty">No contacts yet</div>';
      document.getElementById('dt-log').innerHTML='';
      document.getElementById('dt-s-crm').textContent='0';
      document.getElementById('dt-s-total').textContent='0';
      document.getElementById('dt-s-deals').textContent='0';
      document.getElementById('dt-s-skipped').textContent='0';
      document.getElementById('dt-s-remain').textContent='—';
      document.getElementById('dt-btn-crm').disabled=true;
      document.getElementById('dt-btn-resume').disabled=true;
      dtSetDot('green','Bridge connected — ready');
    }catch(e){}
  };

  window.dtExportCSV=function(){
    if(!dtContacts.length){alert('No contacts to export yet.');return;}
    var fields=['first_name','last_name','phone','mobile_phone','email','address_no','street_name','city','province','postal_code','deal_number','lender','status','source','captured_at'];
    var rows=[fields.join(',')];
    dtContacts.forEach(function(c){rows.push(fields.map(function(f){return '"'+((c[f]||'').toString().replace(/"/g,'""'))+'"';}).join(','));});
    var a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([rows.join('\n')],{type:'text/csv'}));
    a.download='dt_contacts_'+new Date().toISOString().slice(0,10)+'.csv';
    a.click();
  };

  window.dtPushCRM=async function(){
    if(!dtContacts.length){alert('No contacts to push.');return;}
    var mode=(document.getElementById('dt-crm-mode')||{}).value||'add';
    var pushed=0,updated=0,skipped=0;

    // Replace mode: hard delete all CRM contacts first
    if(mode==='replace'){
      if(!confirm('REPLACE will delete ALL existing CRM contacts and replace with DT Sync data.\n\nThis cannot be undone. Continue?'))return;
      try{
        // Delete all existing CRM entries for this user
        var crmResp=await FF.apiFetch('/api/desk/crm').then(function(r){return r.json();});
        if(crmResp.success&&crmResp.crm){
          for(var d=0;d<crmResp.crm.length;d++){
            await FF.apiFetch('/api/desk/crm/'+crmResp.crm[d].id,{method:'DELETE'}).catch(function(){});
          }
        }
        crmData=[];
      }catch(e){console.error('DT CRM replace clear error:',e);}
    }

    for(var i=0;i<dtContacts.length;i++){
      var c=dtContacts[i];
      var name=((c.first_name||'')+' '+(c.last_name||'')).trim();
      if(!name)continue;
      var source='DT Scrape'+(c.lender?' | '+c.lender:'')+(c.deal_number?' | #'+c.deal_number:'');
      var phone=c.mobile_phone||c.phone||'';
      var email=c.email||'';

      // Check if contact already exists
      var existingIdx=-1;
      for(var j=0;j<crmData.length;j++){
        if(crmData[j].name===name&&crmData[j].source&&crmData[j].source.indexOf('DT Scrape')>-1){existingIdx=j;break;}
      }

      if(mode==='add'&&existingIdx>=0){skipped++;continue;}

      if(mode==='merge'&&existingIdx>=0){
        // Update existing contact with latest data
        try{
          var upd=await FF.apiFetch('/api/desk/crm/'+crmData[existingIdx].id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({
            phone:phone,email:email,source:source,status:'Lead'
          })}).then(function(r){return r.json();});
          if(upd.success){crmData[existingIdx].phone=phone;crmData[existingIdx].email=email;updated++;}
        }catch(e){console.error('DT CRM merge error:',e);}
        continue;
      }

      // Add new contact
      try{
        var res=await FF.apiFetch('/api/desk/crm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          name:name,phone:phone,email:email,beacon:'',status:'Lead',source:source,notes:''
        })}).then(function(r){return r.json();});
        if(res.success){
          crmData.unshift({
            id:res.entry.id,date:new Date().toLocaleDateString('en-CA'),
            name:name,phone:phone,email:email,
            vehicle:source,stock:'',beacon:'',status:'Lead',source:source
          });
          pushed++;
        }
      }catch(e){console.error('DT CRM push error:',e);}
    }
    var parts=[];
    if(pushed)parts.push(pushed+' added');
    if(updated)parts.push(updated+' updated');
    if(skipped)parts.push(skipped+' skipped');
    var msg=parts.join(', ')||'No changes';
    if(pushed>0||updated>0){
      renderCRM();
      dtCRMCount+=pushed;
      document.getElementById('dt-s-crm').textContent=dtCRMCount;
    }
    var t=document.getElementById('dt-crm-toast');
    if(t){t.textContent=msg;t.style.display='block';setTimeout(function(){t.style.display='none';},4000);}
    if(typeof toast==='function')toast('DT Sync: '+msg);
  };

  function dtInit(){
    dtPing();
    if(!dtPollTimer)dtPollTimer=setInterval(dtPoll,1500);
  }

  var _origShow=window.showSection;
  window.showSection=function(id,btn){
    _origShow(id,btn);
    if(id==='dtsync')dtInit();
  };
})();

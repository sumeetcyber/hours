import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const app=express();
const PORT=process.env.PORT||3000;
const URL=process.env.SUPABASE_URL;
const ANON=process.env.SUPABASE_ANON_KEY;
const SERVICE=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!URL||!ANON||!SERVICE) throw new Error('Missing Supabase environment variables');
const admin=createClient(URL,SERVICE,{auth:{autoRefreshToken:false,persistSession:false}});
const auth=createClient(URL,ANON,{auth:{autoRefreshToken:false,persistSession:false}});
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'100kb'}));
app.use(cookieParser());
app.use(rateLimit({windowMs:15*60*1000,max:300,standardHeaders:true,legacyHeaders:false}));

function setSession(res,session){
  res.cookie('hours_access',session.access_token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',maxAge:session.expires_in*1000,path:'/'});
  res.cookie('hours_refresh',session.refresh_token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',maxAge:90*24*3600*1000,path:'/'});
}
function clearSession(res){res.clearCookie('hours_access',{path:'/'});res.clearCookie('hours_refresh',{path:'/'});}
async function getUser(req,res,next){
  let token=req.cookies.hours_access;
  if(!token){return res.status(401).json({error:'unauthenticated'})}
  let {data,error}=await auth.auth.getUser(token);
  if(error||!data.user){
    const refresh=req.cookies.hours_refresh;
    if(!refresh) return res.status(401).json({error:'unauthenticated'});
    const r=await auth.auth.refreshSession({refresh_token:refresh});
    if(r.error||!r.data.session) return res.status(401).json({error:'unauthenticated'});
    setSession(res,r.data.session); token=r.data.session.access_token; data=await auth.auth.getUser(token).then(x=>x.data);
  }
  req.user=data.user; next();
}

app.post('/api/auth/send-otp', async (req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'invalid email'});
  const r=await auth.auth.signInWithOtp({email,options:{shouldCreateUser:true}});
  if(r.error) return res.status(400).json({error:r.error.message});
  res.json({ok:true});
});
app.post('/api/auth/verify-otp', async (req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase();
  const token=String(req.body.token||'').trim();
  if(!/^\d{6}$/.test(token)) return res.status(400).json({error:'invalid code'});
  const r=await auth.auth.verifyOtp({email,token,type:'email'});
  if(r.error||!r.data.session) return res.status(401).json({error:r.error?.message||'invalid code'});
  setSession(res,r.data.session); res.json({ok:true,user:{id:r.data.user.id,email:r.data.user.email}});
});
app.post('/api/auth/signout',getUser,async(req,res)=>{clearSession(res);res.json({ok:true})});
app.get('/api/auth/me',getUser,(req,res)=>res.json({user:{id:req.user.id,email:req.user.email}}));

function sanitizeState(s){
  if(!s||typeof s!=='object') throw new Error('bad state');
  const pursuits=Array.isArray(s.pursuits)?s.pursuits:[];
  const entries=Array.isArray(s.entries)?s.entries:[];
  return {pursuits:JSON.parse(JSON.stringify(pursuits)),entries:JSON.parse(JSON.stringify(entries)),active:s.active||null,theme:String(s.theme||'system'),wishfulDefault:Number(s.wishfulDefault||0)};
}
async function getState(userId){
  const {data,error}=await admin.from('user_state').select('state').eq('user_id',userId).maybeSingle();
  if(error) throw error;
  return data?.state||{pursuits:[],entries:[],active:null,theme:'system',wishfulDefault:8};
}
app.get('/api/state',getUser,async(req,res)=>{try{res.json(await getState(req.user.id))}catch(e){res.status(500).json({error:'state read failed'})}});
app.put('/api/state',getUser,async(req,res)=>{
  try{
    const state=sanitizeState(req.body);
    const {error}=await admin.from('user_state').upsert({user_id:req.user.id,state,updated_at:new Date().toISOString()},{onConflict:'user_id'});
    if(error) throw error; res.json({ok:true});
  }catch(e){res.status(400).json({error:'invalid state'});}
});

// Server-authoritative realtime: clients receive only their own user's version.
const sse=new Map();
app.get('/api/events',getUser,(req,res)=>{
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.flushHeaders();
  const id=req.user.id; if(!sse.has(id))sse.set(id,new Set());sse.get(id).add(res);
  res.write(`event: ready\ndata: {}\n\n`);
  req.on('close',()=>sse.get(id)?.delete(res));
});
const channel=admin.channel('hours-server-state').on('postgres_changes',{event:'*',schema:'public',table:'user_state'},payload=>{
  const uid=payload.new?.user_id||payload.old?.user_id;if(!uid)return;
  for(const res of sse.get(uid)||[]) res.write(`event: state\ndata: ${JSON.stringify({updated_at:payload.new?.updated_at||null})}\n\n`);
}).subscribe();

app.use(express.static('public',{index:'index.html',extensions:['html']}));
app.use((req,res)=>res.sendFile(process.cwd()+'/public/index.html'));
app.listen(PORT,()=>console.log(`HOURS online on :${PORT}`));

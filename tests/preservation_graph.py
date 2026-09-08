"""Reference graph verifier for qpdf JSON v2 with decoded inline streams.

This deliberately checks graph alias topology as well as values. It is a
regression-test reference implementation, not an arbitrary PDF conformance
checker. Inputs must come from qpdf --json-output=2 --json-stream-data=inline
--decode-level=generalized. Serialize-only trailer keys may differ. All other
reachable data and decoded stream bytes must be equal, except exact caller-
approved page Rotate/CropBox values identified by ORIGINAL object references.
No user PDF or user path is stored in this module.
"""
from pathlib import Path
import json,re,hashlib,collections
REFERENCE=re.compile(r'^\d+ \d+ R$')
SERIALIZATION={'/ID','/Size','/Prev','/XRefStm','/Type','/W','/Index','/Length','/Filter','/DecodeParms'}
def compare(left,right,allowed=None):
 a=left['qpdf'][1];b=right['qpdf'][1];allowed=allowed or {};mapping={};reverse={};diff=[];streams=0;nodes=0
 ta=a['trailer']['value'];tb=b['trailer']['value']
 todo=collections.deque([({k:v for k,v in ta.items() if k not in SERIALIZATION},{k:v for k,v in tb.items() if k not in SERIALIZATION},'trailer',None)])
 def show(v):
  t=json.dumps(v,separators=(',',':'))
  return t if len(t)<160 else {'serializedLength':len(t),'sha256':hashlib.sha256(t.encode()).hexdigest()}
 while todo:
  x,y,path,ref=todo.popleft();nodes+=1
  xr=isinstance(x,str) and bool(REFERENCE.fullmatch(x));yr=isinstance(y,str) and bool(REFERENCE.fullmatch(y))
  if xr or yr:
   if not(xr and yr):diff.append([path,'reference-vs-value',show(x),show(y)]);continue
   if x in mapping:
    if mapping[x]!=y:diff.append([path,'alias mismatch',x,y,mapping[x]])
    continue
   if y in reverse:diff.append([path,'reverse alias mismatch',x,y,reverse[y]]);continue
   mapping[x]=y;reverse[y]=x
   if 'obj:'+x not in a or 'obj:'+y not in b:diff.append([path,'missing referenced object',x,y]);continue
   todo.append((a['obj:'+x],b['obj:'+y],path+'->'+x,x));continue
  if isinstance(x,dict) and isinstance(y,dict):
   rules=allowed.get(ref,{}) if path.endswith('/value') else {}
   for key,expected in rules.items():
    if key not in y or y[key]!=expected:
     diff.append([path+'/'+key,'missing or unexpected requested geometry',show(expected),show(y.get(key))])
   for key in sorted(set(x)|set(y)):
    if key in rules:
     continue
    elif key not in x or key not in y:diff.append([path+'/'+key,'key mismatch',key in x,key in y])
    elif key=='data' and path.endswith('/stream'):
     streams+=1
     if x[key]!=y[key]:diff.append([path+'/'+key,'decoded stream changed',show(x[key]),show(y[key])])
    else:todo.append((x[key],y[key],path+'/'+key,ref))
  elif isinstance(x,list) and isinstance(y,list):
   if len(x)!=len(y):diff.append([path,'array length',len(x),len(y)])
   todo.extend((xx,yy,path+'/'+str(i),ref) for i,(xx,yy) in enumerate(zip(x,y)))
  elif x!=y:diff.append([path,'value mismatch',show(x),show(y)])
 return {'equivalent':not diff,'pairedReachableObjects':len(mapping),'decodedStreamsCompared':streams,'visitedNodes':nodes,'differences':diff[:30],'differenceCount':len(diff)}

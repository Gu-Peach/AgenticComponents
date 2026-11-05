import json,re
def require(ok,message):
 if not ok:raise ValueError(message)

def parse(text):
 tokens=[];pattern=re.compile(r'\s+|;[^\n]*|[()]|"(?:[^"\\]|\\.)*"|[^\s();"]+')
 pos=0
 while pos<len(text):
  m=pattern.match(text,pos);require(m is not None,f'非法词法位置 {pos}')
  token=m.group();pos=m.end()
  if token.isspace() or token.startswith(';'):continue
  tokens.append(token)
 stack=[];roots=[]
 for token in tokens:
  if token=='(':
   item=[]
   (stack[-1] if stack else roots).append(item);stack.append(item)
  elif token==')':require(bool(stack),'多余闭括号');stack.pop()
  else:
   require(bool(stack),'顶层必须为列表');stack[-1].append(json.loads(token) if token.startswith('"') else token)
 require(not stack and len(roots)==1,'括号未闭合或多个顶层表达式')
 return roots[0]


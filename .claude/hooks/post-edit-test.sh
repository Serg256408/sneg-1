#!/bin/bash
# Hook: run tests after editing analytics.js or src/**/*.js
# Reads stdin JSON, checks if file matches, runs tests if so

INPUT=$(cat)
FILE=$(echo "$INPUT" | .tools/node-v24.14.0-win-x64/node.exe -e "
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  try{const j=JSON.parse(d);console.log(j.tool_input?.file_path||j.tool_response?.filePath||'')}
  catch(e){console.log('')}
})")

if echo "$FILE" | grep -qE "(analytics\.js|src/.*\.js|src\\\\.*\.js)"; then
  cd "c:/Users/User/Desktop/Prodavzi/sneg-1"
  RESULT=$(.tools/node-v24.14.0-win-x64/node.exe test.js 2>&1)
  EXIT=$?
  if [ $EXIT -ne 0 ]; then
    echo "{\"continue\":true,\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"TESTS FAILED:\\n$RESULT\"}}"
  fi
fi

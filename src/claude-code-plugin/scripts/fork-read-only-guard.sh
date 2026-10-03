#!/bin/sh
# PreToolUse guard for a receptionist fork of a surface: only read-only tools run.
#
# The fork keeps every tool its source surface has, because the tool list is
# part of the prompt prefix the fork must share to read the source's prompt
# cache. So read-only is enforced here, at call time, instead of by removing
# tools. Permission modes cannot do it: the user's settings may allow writes.
# Exit code 2 refuses the call and shows the model the message on stderr.
if grep -Eq '"tool_name" *: *"(Read|Grep|Glob)"'; then exit 0; fi
echo "You are a read-only copy answering one question. Only Read, Grep and Glob are available; answer from what you already know." >&2
exit 2

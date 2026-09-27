#!/bin/bash
# Rebase sequence editor: mark chosen commits 'squash'.
TODO="$1"
squash=" 5a99831 818afc4 b376914 527484e 8118ea3 e03111b 714aaa3 14f9d21 b7a0179 ba5fbc0 da5bdfa 7c75521 7c2f6c7 bbce185 7ad0c87 2c70848 e4a0281 4e8ed43 2b4502a 19e0d47 3553c0b 8db47fa ae9e954 d14d394 a182e5d e400c40 09e2077 "
while IFS= read -r line; do
  sha=$(echo "$line" | awk '{print $2}' | cut -c1-7)
  if [[ "$line" == pick* ]] && [[ "$squash" == *" $sha "* ]]; then
    echo "squash $line" | sed 's/^squash pick/squash/'
  else
    echo "$line"
  fi
done < "$TODO" > "$TODO.new"
mv "$TODO.new" "$TODO"

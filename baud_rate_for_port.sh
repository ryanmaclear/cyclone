#!/bin/bash

for b in 115200 250000 57600 38400 230400; do
  echo "===== Trying $b ====="
  stty -F /dev/ttyUSB0 "$b" raw -echo
  sleep 3
  printf "\n\nM115\n" > /dev/ttyUSB0
  timeout 4 cat /dev/ttyUSB0
  echo
done


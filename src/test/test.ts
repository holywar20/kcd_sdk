#!/usr/bin/env node
'use strict';

const path = require('path');
const fs   = require('fs');

//const targetPath = path.resolve(process.argv[2] ?? '.');

const TARGET_PATH = "C:/idt/_Claude/lenses/lens_crafter";

const { scan } = require('../../dist/index.js');

// Your object
var obj = scan(TARGET_PATH);

(async () => {
  console.log(obj);
})();
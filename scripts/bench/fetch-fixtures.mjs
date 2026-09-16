#!/usr/bin/env node
// Rebuilds scripts/bench/fixtures/, which .gitignore keeps out of the repo (docs/bench.md).
//
//   node scripts/bench/fetch-fixtures.mjs
//
// Three kinds of file:
//   1. The ten tables of the sampled InfiAgent-DABench questions, fetched from that project's
//      repository. Third-party data — referenced, not vendored.
//   2. Four small tables written here by hand, each built to trigger one known failure. They are
//      part of the test definition, so their content lives in this file, not in a download.
//   3. One two-sheet workbook, built by running pandas inside the worker image — the same image
//      the benchmark runs against, so no Python is needed on the host.

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const DABENCH = 'https://raw.githubusercontent.com/InfiAgent/InfiAgent/main/examples/DA-Agent/data/da-dev-tables'

const DOWNLOADED = [
  '2014_q4.csv',
  '2015.csv',
  '20170413_000000_group_statistics.csv',
  'auto-mpg.csv',
  'bitconnect_price.csv',
  'gapminder_gdp_asia.csv',
  'microsoft.csv',
  'ravenna_250715.csv',
  'test_x.csv',
  'unemployement_industry.csv',
]

// Written by hand for the `hard-*` cases; the answers in those cases are computed from exactly
// these rows, so changing a number here invalidates the case that reads it.
const WRITTEN = {
  // hard-csv-chau-au: ';' separator and ',' decimal — mean 1333.33.
  'doanh-thu-eu.csv': 'Ngay;Doanh thu;Vung\n2024-01-01;1.234,50;Bac\n2024-01-02;2.000,25;Nam\n2024-01-03;765,25;Bac\n',
  // hard-bay-thieu-file: 1000 in 2023, 1250 in 2024 — a rise of 25%.
  'ban-2023.csv': 'Thang,Doanh thu\n1,250\n2,250\n3,250\n4,250\n',
  'ban-2024.csv': 'Thang,Doanh thu\n1,300\n2,300\n3,325\n4,325\n',
  // hard-cot-toan-nan: the stock column is empty, and pandas sums an empty column to 0.0.
  'kho-hang.csv': 'Ma,Ten,Ton kho\nA1,But,\nA2,Vo,\nA3,Thuoc,\nA4,Tay,\n',
}

// hard-excel-sheet: 10+20 on the first sheet, 30+40+50 on the second — 150 for the whole book.
const WORKBOOK = `
import pandas as pd
writer = pd.ExcelWriter('/out/ban-hang-2quy.xlsx')
pd.DataFrame({'Thang': [1, 2], 'Doanh thu': [10, 20]}).to_excel(writer, sheet_name='Quy1', index=False)
pd.DataFrame({'Thang': [3, 4, 5], 'Doanh thu': [30, 40, 50]}).to_excel(writer, sheet_name='Quy2', index=False)
writer.close()
`

async function main() {
  await mkdir(FIXTURES, { recursive: true })

  for (const name of DOWNLOADED) {
    const response = await fetch(`${DABENCH}/${name}`)
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
    await writeFile(join(FIXTURES, name), Buffer.from(await response.arrayBuffer()))
    console.log(`  tải về  ${name}`)
  }

  for (const [name, content] of Object.entries(WRITTEN)) {
    await writeFile(join(FIXTURES, name), content)
    console.log(`  viết ra ${name}`)
  }

  await run('docker', [
    'run', '--rm', '--entrypoint', '/opt/fox-py/bin/python',
    '-v', `${FIXTURES}:/out`, 'fox-harness-worker:dev', '-c', WORKBOOK,
  ])
  await stat(join(FIXTURES, 'ban-hang-2quy.xlsx'))
  console.log('  dựng ra ban-hang-2quy.xlsx (chạy pandas trong image worker)')
  console.log('\nxong — dữ liệu bài đo đã sẵn sàng.')
}

await main()

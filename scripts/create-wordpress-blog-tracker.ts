import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ExcelJS from "exceljs";
import { defaultTrackerPath, requiredTrackerHeaders } from "./wordpress-blog-writer.js";

const target = resolve(process.argv[2] ?? defaultTrackerPath);
const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("Blog tracker", {
  views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
});
sheet.addRow(requiredTrackerHeaders);
sheet.getRow(1).height = 24;
sheet.getRow(1).eachCell((cell) => {
  cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
  cell.border = {
    top: { style: "thin", color: { argb: "FFB8C4D1" } },
    bottom: { style: "thin", color: { argb: "FFB8C4D1" } },
  };
});
sheet.columns = [
  { key: "blog_id", width: 18 },
  { key: "blog_topic", width: 42 },
  { key: "blog_status", width: 16 },
  { key: "blog_created_date", width: 29, style: { numFmt: "mmm dd, yyyy h:mm:ss AM/PM" } },
  { key: "blog_posted_date", width: 29, style: { numFmt: "mmm dd, yyyy h:mm:ss AM/PM" } },
];
sheet.autoFilter = "A1:E1";
for (let row = 2; row <= 200; row += 1)
  sheet.getCell(row, 3).dataValidation = {
    type: "list",
    allowBlank: true,
    formulae: ['"pending,complete,uploaded"'],
  };
await mkdir(dirname(target), { recursive: true });
await workbook.xlsx.writeFile(target);
console.log(target);

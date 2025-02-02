// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃ ██████ ██████ ██████       █      █      █      █      █ █▄  ▀███ █       ┃
// ┃ ▄▄▄▄▄█ █▄▄▄▄▄ ▄▄▄▄▄█  ▀▀▀▀▀█▀▀▀▀▀ █ ▀▀▀▀▀█ ████████▌▐███ ███▄  ▀█ █ ▀▀▀▀▀ ┃
// ┃ █▀▀▀▀▀ █▀▀▀▀▀ █▀██▀▀ ▄▄▄▄▄ █ ▄▄▄▄▄█ ▄▄▄▄▄█ ████████▌▐███ █████▄   █ ▄▄▄▄▄ ┃
// ┃ █      ██████ █  ▀█▄       █ ██████      █      ███▌▐███ ███████▄ █       ┃
// ┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
// ┃ Copyright (c) 2017, the Perspective Authors.                              ┃
// ┃ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ ┃
// ┃ This file is part of the Perspective library, distributed under the terms ┃
// ┃ of the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

const { test, expect } = require("@playwright/test");
const perspective = require("@finos/perspective");

const fs = require("fs");

const arr = fs.readFileSync(
    require.resolve("superstore-arrow/superstore.arrow")
).buffer;

/**
 * Run a function in a loop, comparing before-and-after wasm heap for leaks.
 * Emscripten allocates in pages, and Perspective is hard coded to start at
 * 16777216b, so rather than check `end - start`, we just test that any
 * allocation ever occurs.
 * @param {*} test
 * @param {*} num_iterations
 */
async function leak_test(test, num_iterations = 10000) {
    // warmup
    await test();

    // TODO Playwright uses the same host instance so this may have grown by
    // the time the suite runs. Could fix with a nod eagent (and test in other
    // browsers).

    // expect((await perspective.memory_usage()).wasmHeap).toEqual(16777216);
    const start = (await perspective.memory_usage()).wasmHeap;

    for (var i = 0; i < num_iterations; i++) {
        await test();
    }

    // expect((await perspective.memory_usage()).wasmHeap).toEqual(16777216);
    expect((await perspective.memory_usage()).wasmHeap).toEqual(start);
}

/**
 * Given columns a (int), b (float), c (string) and d (datetime),
 * generate expressions that use all columns and scalar values.
 */
function generate_expressions() {
    const expressions = ["concat('abcd', \"c\", 'efg')"];

    for (const op of ["+", "-", "*", "/", "^", "%"]) {
        expressions.push(
            `("a" ${op} "b") + ${Math.floor(Math.random() * 100)}`
        );
    }

    for (const fn of ["sqrt", "log10", "deg2rad"]) {
        expressions.push(`${fn}("b")`);
    }

    for (const fn of ["upper", "lower", "length"]) {
        expressions.push(`${fn}("c")`);
    }

    for (const unit of ["m", "D"]) {
        expressions.push(`bucket("d", '${unit}')`);
    }

    return expressions;
}

test.describe("leaks", function () {
    test.describe("view", function () {
        test.describe("1-sided", function () {
            test("to_json does not leak", async () => {
                const table = await perspective.table(arr.slice());
                const view = await table.view({ group_by: ["State"] });
                await leak_test(async function () {
                    let json = await view.to_json();
                    expect(json.length).toEqual(50);
                });
                view.delete();
                table.delete();
            });

            test("to_columns_string does not leak", async () => {
                const table = await perspective.table(arr.slice());
                const view = await table.view({ group_by: ["State"] });
                await leak_test(async function () {
                    let json = await view.to_columns_string();
                    expect(json.length).toEqual(6722);
                });
                view.delete();
                table.delete();
            });
        });
    });

    test.describe("table", function () {
        test("update does not leak", async () => {
            const table = await perspective.table(
                { x: "integer", y: "string" },
                { index: "x" }
            );
            let count = 0;
            const view = await table.view();
            view.on_update(function () {
                count += 1;
            });

            await leak_test(async function () {
                await table.update([{ x: 1, y: "TestTestTest" }]);
                expect(await table.size()).toEqual(1);
            });

            expect(count).toBeGreaterThan(0);
            view.delete();
            table.delete();
        });

        test.skip("csv loading does not leak", async () => {
            const table = await perspective.table(arr.slice());
            const view = await table.view();
            const csv = await view.to_csv({ end_row: 10 });
            view.delete();
            table.delete();
            await leak_test(async function () {
                const table = await perspective.table(csv);
                expect(await table.size()).toEqual(10);
                await table.delete();
            });
        });
    });

    test.describe("expression columns", function () {
        test("0 sided does not leak", async () => {
            const table = await perspective.table({
                a: [1, 2, 3, 4],
                b: [1.5, 2.5, 3.5, 4.5],
                c: ["a", "b", "c", "d"],
                d: [new Date(), new Date(), new Date(), new Date()],
            });

            const expressions = generate_expressions();

            await leak_test(async () => {
                const view = await table.view({
                    expressions: [
                        expressions[
                            Math.floor(Math.random() * expressions.length)
                        ],
                    ],
                });
                const expression_schema = await view.expression_schema();
                expect(Object.keys(expression_schema).length).toEqual(1);
                await view.delete();
            });

            await table.delete();
        });

        /**
         * Because the expression vocab and the regex cache is per-table and
         * not per-view, we should be able to leak test the table creation
         * and view creation.
         */
        test.skip("0 sided regex does not leak", async () => {
            const expressions = [
                "match(\"a\", '.{1}')",
                "match_all(\"a\", '[a-z]{1}')",
                "search(\"a\", '.')",
            ];

            await leak_test(async () => {
                const table = await perspective.table({
                    a: "abcdefghijklmnopqrstuvwxyz".split(""),
                });
                const view = await table.view({
                    expressions: [
                        expressions[
                            Math.floor(Math.random() * expressions.length)
                        ],
                    ],
                });
                const expression_schema = await view.expression_schema();
                expect(Object.keys(expression_schema).length).toEqual(1);
                await view.delete();
                await table.delete();
            });
        });

        test.skip("0 sided string does not leak", async () => {
            const table = await perspective.table({
                a: "abcdefghijklmnopqrstuvwxyz".split(""),
            });

            const expressions = [
                "var x := 'abcdefghijklmnopqrstuvwxyz'; concat(\"a\", x, 'abc')",
                "var x := 'abcdefghijklmnopqrstuvwxyz'; var y := 'defhijklmnopqrst'; concat(\"a\", x, 'abc', y)",
            ];

            await leak_test(async () => {
                const view = await table.view({
                    expressions: [
                        expressions[
                            Math.floor(Math.random() * expressions.length)
                        ],
                    ],
                });
                const expression_schema = await view.expression_schema();
                expect(Object.keys(expression_schema).length).toEqual(1);
                await view.delete();
            });

            await table.delete();
        });

        test("1 sided does not leak", async () => {
            const table = await perspective.table({
                a: [1, 2, 3, 4],
                b: [1.5, 2.5, 3.5, 4.5],
                c: ["a", "b", "c", "d"],
                d: [new Date(), new Date(), new Date(), new Date()],
            });

            const columns = ["a", "b", "c", "d"];
            const expressions = generate_expressions();

            await leak_test(async () => {
                const view = await table.view({
                    group_by: [
                        columns[Math.floor(Math.random() * columns.length)],
                    ],
                    expressions: [
                        expressions[
                            Math.floor(Math.random() * expressions.length)
                        ],
                    ],
                });
                const expression_schema = await view.expression_schema();
                expect(Object.keys(expression_schema).length).toEqual(1);
                await view.delete();
            }, 3000);

            await table.delete();
        });

        test("2 sided does not leak", async () => {
            const table = await perspective.table({
                a: [1, 2, 3, 4],
                b: [1.5, 2.5, 3.5, 4.5],
                c: ["a", "b", "c", "d"],
                d: [new Date(), new Date(), new Date(), new Date()],
            });

            const columns = ["a", "b", "c", "d"];
            const expressions = generate_expressions();

            await leak_test(async () => {
                const view = await table.view({
                    group_by: [
                        columns[Math.floor(Math.random() * columns.length)],
                    ],
                    split_by: [
                        columns[Math.floor(Math.random() * columns.length)],
                    ],
                    expressions: [
                        expressions[
                            Math.floor(Math.random() * expressions.length)
                        ],
                    ],
                });
                const expression_schema = await view.expression_schema();
                expect(Object.keys(expression_schema).length).toEqual(1);
                await view.delete();
            }, 3000);

            await table.delete();
        });
    });
});

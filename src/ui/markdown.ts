import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Definition, Nodes, Root, Table } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm).freeze();

const linkUrl = (url: string): Option.Option<string> => {
  // oxlint-disable-next-line no-control-regex -- Browsers ignore ASCII controls in URL schemes.
  const compactUrl = url.replace(/[\u0000-\u0020\u007f]/g, "");
  return Result.match(
    Result.try(() => new URL(compactUrl, "https://markdown.invalid")),
    {
      onFailure: () => Option.none(),
      onSuccess: (parsed) =>
        ["https:", "http:", "mailto:", "tel:"].includes(parsed.protocol)
          ? Option.some(compactUrl)
          : Option.none(),
    },
  );
};

const definitionsIn = (node: Nodes): ReadonlyArray<Definition> => {
  if (node.type === "definition") {
    return [node];
  }
  return "children" in node ? node.children.flatMap(definitionsIn) : [];
};

const markdownView = <Message>(document: Root, h: HtmlBuilder<Message>): Html => {
  const definitions = new Map(
    definitionsIn(document)
      .toReversed()
      .map((definition) => [definition.identifier, definition]),
  );
  const link = (url: string, content: ReadonlyArray<Html | string>, title?: string | null) =>
    Option.match(linkUrl(url), {
      onNone: () => h.span([], content),
      onSome: (safeUrl) =>
        h.a(
          [
            h.Href(safeUrl),
            ...(safeUrl.startsWith("#") || /^(?:mailto|tel):/i.test(safeUrl)
              ? []
              : [h.Target("_blank"), h.Rel("noopener noreferrer")]),
            ...(title ? [h.Title(title)] : []),
          ],
          content,
        ),
    });
  const image = (url: string, alt?: string | null, title?: string | null) =>
    link(url, [`Image: ${alt || "View image"}`], title);
  const table = (node: Table) =>
    h.div(
      [h.Class("markdown-table-scroll max-w-full overflow-x-auto")],
      [
        h.table(
          [],
          [
            h.thead(
              [],
              node.children.slice(0, 1).map((row) => tableRow(row, node, true)),
            ),
            h.tbody(
              [],
              node.children.slice(1).map((row) => tableRow(row, node, false)),
            ),
          ],
        ),
      ],
    );
  const tableRow = (row: Table["children"][number], node: Table, isHeader: boolean) =>
    h.tr(
      [],
      row.children.map((cell, index) => {
        const alignment = node.align?.[index];
        const attributes = alignment ? [h.Style({ "text-align": alignment })] : [];
        return isHeader
          ? h.th([h.Scope("col"), ...attributes], cell.children.map(render))
          : h.td(attributes, cell.children.map(render));
      }),
    );
  const render = (node: Nodes): Html | string =>
    Match.value(node).pipe(
      Match.withReturnType<Html | string>(),
      Match.discriminatorsExhaustive("type")({
        root: (node) => h.div([], node.children.map(render)),
        text: (node) => node.value,
        html: (node) => node.value,
        yaml: (node) => node.value,
        paragraph: (node) => h.p([], node.children.map(render)),
        emphasis: (node) => h.em([], node.children.map(render)),
        strong: (node) => h.strong([], node.children.map(render)),
        delete: (node) => h.del([], node.children.map(render)),
        inlineCode: (node) => h.code([], [node.value]),
        code: (node) =>
          h.pre(
            [h.Class("max-w-full overflow-x-auto whitespace-pre"), h.Tabindex(0)],
            [h.code([], [node.value])],
          ),
        break: () => h.br([]),
        thematicBreak: () => h.hr([]),
        heading: (node) =>
          Match.value(node.depth).pipe(
            Match.when(1, () => h.h2([], node.children.map(render))),
            Match.when(2, () => h.h3([], node.children.map(render))),
            Match.when(3, () => h.h4([], node.children.map(render))),
            Match.when(4, () => h.h5([], node.children.map(render))),
            Match.when(5, () => h.h6([], node.children.map(render))),
            Match.when(6, () => h.h6([], node.children.map(render))),
            Match.exhaustive,
          ),
        blockquote: (node) => h.blockquote([], node.children.map(render)),
        list: (node) =>
          node.ordered
            ? h.ol(node.start ? [h.Start(node.start)] : [], node.children.map(render))
            : h.ul([], node.children.map(render)),
        listItem: (node) =>
          h.li(
            [],
            [
              ...(typeof node.checked === "boolean"
                ? [
                    h.span(
                      [
                        h.Class("markdown-task-marker"),
                        h.Role("img"),
                        h.AriaLabel(node.checked ? "Completed task" : "Incomplete task"),
                      ],
                      [node.checked ? "☑ " : "☐ "],
                    ),
                  ]
                : []),
              ...node.children.map(render),
            ],
          ),
        link: (node) => link(node.url, node.children.map(render), node.title),
        image: (node) => image(node.url, node.alt, node.title),
        linkReference: (node) => {
          const definition = definitions.get(node.identifier);
          return definition
            ? link(definition.url, node.children.map(render), definition.title)
            : h.span([], node.children.map(render));
        },
        imageReference: (node) => {
          const definition = definitions.get(node.identifier);
          return definition
            ? image(definition.url, node.alt, definition.title)
            : h.span([], [`Image: ${node.alt || "View image"}`]);
        },
        definition: () => h.empty,
        table,
        tableRow: (node) => h.tr([], node.children.map(render)),
        tableCell: (node) => h.td([], node.children.map(render)),
        footnoteReference: (node) => h.sup([], [`[${node.label || node.identifier}]`]),
        footnoteDefinition: (node) =>
          h.div(
            [h.Class("markdown-footnote")],
            [h.span([], [`[${node.label || node.identifier}] `]), ...node.children.map(render)],
          ),
      }),
    );

  return h.div([h.Class("message-markdown min-w-0 max-w-full")], document.children.map(render));
};

/** Render untrusted CommonMark/GFM through Foldkit; HTML stays text and images are links. */
export const renderMessageMarkdown = <Message>(text: string, h: HtmlBuilder<Message>): Html =>
  markdownView(parser.parse(text), h);

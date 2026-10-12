import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Route from "foldkit/route";
import * as Url from "foldkit/url";
import { SessionId } from "../model.ts";

const ThreadRoute = Route.defineRouteUnion({
  Workspace: { thread: Schema.Option(SessionId) },
  NotFound: { path: Schema.String },
});
export const workspaceRouter = pipe(
  Route.root,
  Route.query(Schema.Struct({ thread: Schema.OptionFromOptional(SessionId) })),
  Route.mapTo(ThreadRoute.Workspace),
);
const parseThreadUrl = Route.parseUrlWithFallback(workspaceRouter, ThreadRoute.NotFound);
export const selectedThreadFromUrl = (href: string): Option.Option<SessionId> =>
  Option.flatMap(Url.fromString(href), (url) =>
    ThreadRoute.match(parseThreadUrl(url), {
      Workspace: ({ thread }) => thread,
      NotFound: () => Option.none(),
    }),
  );

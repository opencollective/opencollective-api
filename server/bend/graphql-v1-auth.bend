# GraphQL v1: which kinds of authentication the legacy endpoint accepts.
#
# GraphQL v1 has no OAuth scope handling, so token access is refused unless the
# OAuth application or the personal token was explicitly allow-listed. This file
# is the decision itself: `npm run bend:build` compiles it to
# generated/graphql-v1-auth.mjs, which the `/graphql/v1` middleware
# (server/routes.ts) calls through ./graphql-v1-auth.ts. Laws: /LAWS.bend.

import Base

#   oauth_token:                 the request carries an OAuth access token
#   oauth_app_allow_listed:      its application has `data.enableGraphqlV1`
#   personal_token:              the request carries a personal token
#   personal_token_allow_listed: that token has `data.allowGraphQLV1`
type Request is Data:
  Request{oauth_token: Bool, oauth_app_allow_listed: Bool, personal_token: Bool, personal_token_allow_listed: Bool}

type Verdict is Data:
  Accept{}
  RejectOAuthToken{}
  RejectPersonalToken{}

def uses_oauth_token(r: Request) -> Bool:
  match r:
    case Request{oauth, _, _, _}:
      oauth

def oauth_app_is_allow_listed(r: Request) -> Bool:
  match r:
    case Request{_, app_allowed, _, _}:
      app_allowed

def uses_personal_token(r: Request) -> Bool:
  match r:
    case Request{_, _, personal, _}:
      personal

def personal_token_is_allow_listed(r: Request) -> Bool:
  match r:
    case Request{_, _, _, token_allowed}:
      token_allowed

# A token is refused when it is present and not allow-listed.
def is_refused(present: Bool, allow_listed: Bool) -> Bool:
  Bool.and(present, Bool.not(allow_listed))

def gate_checks(oauth_refused: Bool, personal_refused: Bool) -> Verdict:
  match oauth_refused personal_refused:
    case True{} _:
      RejectOAuthToken{}
    case False{} True{}:
      RejectPersonalToken{}
    case False{} False{}:
      Accept{}

def gate(r: Request) -> Verdict:
  match r:
    case Request{oauth, app_allowed, personal, token_allowed}:
      gate_checks(is_refused(oauth, app_allowed), is_refused(personal, token_allowed))

English | [日本語](./README_JP.md)

# Ashi@ Architecture and Safety Design

## 1. Overview

Ashi@ is a web service for discovering and displaying posts containing
[Ashiato Syntax](https://github.com/ashiato-syntax/ashiato-syntax) on a map.

Ashi@ is not a social network and does not maintain a database of social
network posts.

Ashi@ is designed as a **fully static, client-side application**. The user's
browser communicates directly with the supported social network and performs
Ashiato discovery, parsing, and display.

The primary design goals are:

- Minimize the information handled by Ashi@
- Avoid unnecessary integration with social network accounts
- Avoid server-side collection of social network posts
- Minimize infrastructure and operational costs
- Reduce privacy and security risks
- Keep the user experience simple

---

## 2. Initial Scope

### 2.1 Supported Service

The initial version targets **Misskey**.

Misskey is the initial target because the required public search functionality
can be performed directly from the browser.

### 2.2 Bluesky

Bluesky support is deferred.

After the Misskey version has been deployed and evaluated, browser-side search,
pagination, rate limits, API behavior, and operational impact will be reviewed
before deciding whether Bluesky support is necessary and practical.

Ashi@ will not introduce server-side crawling or a search proxy merely to
support additional services.

---

## 3. Core Architecture

Ashi@ v1 uses a **fully static, client-side architecture**.

The Ashi@ server, if used for hosting, only serves static assets. Ashi@ does
not operate a backend for receiving, indexing, storing, or filtering SNS
content.

```text
                     ┌─────────────────┐
                     │     Browser     │
                     │    Ashi@ UI     │
                     └────────┬────────┘
                              │
                              ▼
                     ┌────────────────┐
                     │    Misskey     │
                     │  Public Search │
                     │    #Ashiato    │
                     └───────┬────────┘
                             │
                             ▼
                     Syntax extraction
                             │
                             ▼
                       Syntax parsing
                             │
                             ▼
                     Map / UI rendering
```

The social network retains the social network content.

The browser discovers and processes that content.

Ashi@ provides the client software for discovering, parsing, and displaying
Ashiato.

---

## 4. Client-Side Search

Ashi@ performs social network searches from the frontend.

For Misskey:

1. The browser searches for `#Ashiato`.
2. Search results are received directly from Misskey.
3. The browser extracts Ashiato Syntax from each post.
4. The browser parses the Syntax.
5. The browser applies Ashi@'s display policies.
6. The browser renders the Ashiato on the map.

The social network post itself is not sent to an Ashi@ backend.

Ashi@ does not use a server-side search proxy or crawler.

---

## 5. Discovery Method

Ashiato Syntax itself does not define how posts containing the Syntax are
discovered.

Ashi@ uses the following discovery mechanism for Misskey:

```text
#Ashiato
```

`#Ashiato` is an Ashi@ service-level convention and is not part of the
Ashiato Syntax specification.

Other implementations may use different discovery mechanisms.

The use of a single dedicated hashtag is intended to minimize unnecessary
tag pollution while making Ashiato posts discoverable on the supported
service.

---

## 6. No Ashi@ User Accounts

Ashi@ does not require users to create an Ashi@ account.

Ashi@ does not require OAuth or account linking with Misskey or other social
network services.

Ashi@ does not store:

- Misskey access tokens
- social network account IDs
- user profiles
- passwords
- social network authentication credentials

---

## 7. No Social Network Content Database

Ashi@ does not maintain a database of social network content.

In particular, Ashi@ does not store:

- posts
- authors
- images
- audio
- comments
- social network URLs
- search results

The browser retrieves the necessary information directly from the supported
social network.

---

## 8. No Ashiato Index

Ashi@ does not maintain a centralized index of Ashiato.

Ashi@ does not maintain a server-side database containing:

- Syntax hashes
- issuance IDs
- post IDs
- post URLs
- GPS coordinates
- user accounts
- browsing history

Ashiato is interpreted directly from the social network post in the user's
browser.

This means that another implementation can independently discover and
interpret Ashiato Syntax without depending on an Ashi@ database.

---

## 9. No Location History

Ashi@ does not maintain user location histories.

Ashi@ should not create long-term databases associating:

```text
user
+
time
+
location
```

The service is not intended to track users.

---

## 10. Location Privacy

Location information can reveal:

- a person's whereabouts
- movement patterns
- living areas
- workplaces
- private locations
- other personal information

Accordingly, Ashi@ should avoid displaying unnecessarily precise locations.

Ashi@ may use, for example, approximately 100-meter-level precision as its
default display policy.

This is an Ashi@ service policy and is not a requirement of Ashiato Syntax.

---

## 11. Display Delay

Ashi@ should not display newly created Ashiato immediately in order to reduce
the risk of real-time location tracking.

For example:

```text
SNS post
   │
   ▼
Waiting period
   │
   ▼
Ashi@ display
```

The delay can be determined by information contained in the Syntax and
evaluated entirely in the browser.

The exact delay is an Ashi@ service policy and is not part of the Ashiato
Syntax specification.

---

## 12. Future-Dated Ashiato

Ashi@ v1 does not display Ashiato whose specified time is in the future.

Ashiato Syntax itself may represent future times; this restriction is an
Ashi@ service policy.

This avoids introducing future-content handling into the initial service
design.

Future-dated Ashiato may be considered as a separate feature in the future.

---

## 13. No Proof of Presence

Ashiato Syntax does not prove that the person who generated or posted the
Syntax was physically present at the specified location.

Ashi@ should not describe an Ashiato as cryptographic or authoritative proof
of physical presence.

If proof-of-presence functionality is required in the future, it should be
designed as a separate mechanism.

---

## 14. Encryption Mode

Ashiato Syntax does not provide an encryption mode in v1.

Normal Ashiato Syntax is treated as public information. Ashi@ does not
technically prevent third parties from independently parsing Ashiato Syntax
and creating their own maps or clients.

If future requirements show that a Secret Ashiato must cryptographically
guarantee that its contents can only be obtained on site, an encryption or
concealment mechanism may be designed as a separate Ashiato Syntax extension.

The v1 design does not aim to:

- technically prevent third-party display of Ashiato
- distribute or manage encryption keys
- cryptographically prove physical presence

---

## 15. Map Architecture

Ashi@ does not require a commercial map API.

The map interface may use:

- a blank map
- grid lines
- coordinate-based rendering
- simple geographic shapes
- Ashiato markers

This minimizes dependency on external map providers, API usage limits, and
map service costs.

---

## 16. Infrastructure Minimization

Ashi@ v1 is designed to operate as a static web application.

The Ashi@ service itself does not require:

- a content database
- an Ashiato index
- a search API
- a search proxy
- user accounts
- OAuth
- server-side social network crawling
- a third-party map API

The browser communicates directly with Misskey.

This minimizes infrastructure, operational cost, stored data, and server-side
privacy exposure.

---

## 17. Privacy and Security Principles

Ashi@ follows these principles:

1. Collect as little information as possible.
2. Do not store social network posts.
3. Do not store social network account information.
4. Do not maintain a permanent Ashiato index.
5. Perform social network searches on the client side.
6. Do not maintain user location histories.
7. Apply location-precision and display-delay safety measures.
8. Do not claim that Ashiato proves physical presence.
9. Do not introduce an encryption mode in v1.
10. Avoid server-side processing unless a future feature has a clear and
   necessary purpose.

---

## 18. Legal and Policy Considerations

This architecture is designed to reduce privacy, security, and legal risks by
minimizing the information and content handled by Ashi@.

However, minimizing stored data does not eliminate legal or contractual
responsibilities.

Before public deployment, Ashi@ should review:

- applicable privacy laws
- copyright
- privacy and personality rights
- defamation
- social network terms of service
- API usage policies
- laws and regulations applicable to information distribution platforms
- requests concerning unlawful or infringing content

Ashi@ should provide an appropriate contact mechanism for legal and
rights-related matters.

Before public deployment, applicable laws, the terms of service of supported
social networks, API usage conditions, and other relevant rules should be
checked. Where an issue is difficult to assess, professional advice should
be sought as necessary.

---

## 19. Explicit Non-Goals

Ashi@ is not intended to become:

- a social network
- a social network archive
- a permanent search engine for SNS posts
- a user profiling system
- a location tracking service
- a social network account manager
- a content moderation platform for external social networks
- a long-term location database
- an authoritative proof-of-presence service
- a centralized Ashiato index

Whenever new features are proposed, they should be evaluated against these
non-goals.

---

## 20. Design Summary

Ashi@ intentionally follows an **extremely thin, static architecture**.

```text
                 Social Network
                       │
                 Public Search
                       │
                       ▼
                  User Browser
                       │
                       ▼
                Syntax Processing
                       │
                       ▼
                  Map / UI
```

The social network retains the content.

The browser discovers and processes the content.

Ashi@ provides the client application without maintaining a backend database
for social network content.

This architecture intentionally leaves content storage, social-network
search, account management, and social-network-level moderation to the
supported platform and the user's browser.

Ashi@ itself remains a small, static layer for discovering and visualizing
Ashiato.

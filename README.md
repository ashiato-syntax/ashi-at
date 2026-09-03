English | [日本語](./README_JP.md)

# Ashi@ Architecture and Safety Design

## 1. Overview

Ashi@ is a web service for discovering and displaying posts containing
[Ashiato Syntax](https://github.com/ashiato-syntax/ashiato-syntax) on a map.

Ashi@ is not a social network and does not maintain a database of social
network posts.

Ashi@ is designed as a thin service between the user's browser and
supported social network services.

The primary design goals are:

- Minimize the amount of data retained by Ashi@
- Avoid unnecessary integration with social network accounts
- Avoid server-side collection of social network posts
- Minimize infrastructure and operational costs
- Reduce privacy, security, and legal risks
- Keep the user experience simple

---

## 2. Initial Scope

### 2.1 Supported Service

The initial version targets **Misskey**.

Misskey is suitable for the initial implementation because its public
search functionality can be accessed directly from the browser and
supports the mechanisms required by Ashi@.

### 2.2 Bluesky

Bluesky support is deferred.

After deploying and observing the Misskey version, browser-side search,
pagination, rate limits, API behavior, and operational impact will be
evaluated before deciding whether Bluesky support is necessary and
practical.

Ashi@ will not introduce server-side crawling or search proxies merely to
support additional services.

---

## 3. Core Architecture

Ashi@ uses a **client-side discovery architecture**.

Social network searches are performed directly by the user's browser.

```text
                    ┌─────────────────┐
                    │     Browser     │
                    │    Ashi@ UI     │
                    └────────┬────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼
        ┌───────────────┐        ┌────────────────┐
        │    Misskey    │        │      Ashi@     │
        │ Public Search │        │ Issuance       │
        │   #Ashiato    │        │ Registry API   │
        └───────┬───────┘        └───────┬────────┘
                │                        │
                │ Notes                  │ hash
                ▼                        ▼
        Syntax extraction          visibility status
                │
                ▼
        Canonical Form
                │
                ▼
             Hash
                │
                └───────────────► Registry check
                                      │
                                      ▼
                               Visibility
```

Ashi@'s backend does not receive or store the social network search
results themselves.

---

## 4. Client-Side Search

Ashi@ performs social network searches from the frontend.

For Misskey:

1. The browser searches for `#Ashiato`.
2. Search results are received directly from Misskey.
3. The browser extracts Ashiato Syntax from each post.
4. The browser generates the Syntax Canonical Form.
5. The browser calculates the Syntax hash.
6. The browser queries the Ashi@ Issuance Registry using the hash.
7. If the hash exists and its `visibility` value is `public`, the Ashiato is
   displayed.

The social network post itself is not sent to Ashi@'s backend.

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

---

## 6. Issuance Registry

Ashi@ uses an Issuance Registry to determine whether a Syntax was issued
by Ashi@.

Ashi@-issued Syntax contains an issuance ID using an `x-*` extension
field.

The issuance ID is part of the Syntax and is included when generating its
Canonical Form and hash.

The Registry stores only the following two fields:

```text
hash
visibility
```

No social network post data is stored.

All Ashiato issued by Ashi@, including Secret Ashiato, are registered in the Registry. Registry registration also serves to verify that the Syntax was legitimately issued by Ashi@.

### 6.1 Registry Semantics

Conceptually:

```text
hash       : hash identifying an issued Syntax
visibility : publication state on Ashi@

`visibility` has three states:

```text
public
    → displayed on the map
    → discoverable on site

unlisted
    → not displayed on the map
    → discoverable on the social network when physically on site

suppressed
    → not displayed on the map
    → excluded from Ashi@ discovery
```

`unlisted` and `suppressed` are intentionally distinct.
`unlisted` is a Secret Ashiato: it is not listed on the map, but can still be discovered on site.
`suppressed` is an Ashiato hidden as a result of a non-display request or similar action, and is excluded from Ashi@ discovery.
```

The Registry does not store:

- post content
- author information
- social network account IDs
- social network post IDs
- post URLs
- images
- audio
- GPS coordinates
- social network search results
- user accounts
- browsing history

---

## 7. Hash-Based Identification

Ashi@ does not directly associate an issuance ID with a social network
post.

Instead, the Syntax itself is canonicalized and hashed.

```text
Ashiato Syntax
      │
      ▼
Canonical Form
      │
      ▼
Hash
      │
      ▼
Issuance Registry
```

The same Syntax in Canonical Form produces the same hash.

This allows Ashi@ to recognize an issued Syntax without storing the
original Syntax or the social network post.

---

## 8. Protection Against Unauthorized Copies

A legitimate Ashiato Syntax may be copied by a third party and used in a
fake post before the legitimate post appears in search results.

Because a copied Syntax produces the same hash, when multiple search
results contain the same Syntax, older posts should be processed first.

This reduces the possibility that a copied post interferes with recognition
of the legitimate post.

The Issuance Registry does not prove that a particular social network
account created a given post.

---

## 9. Registry Lifetime

Every Registry entry is automatically deleted after **7 days**.

The 7-day lifetime is enforced using the database's TTL mechanism.

The application does not rely on a separate periodic deletion job.

```text
Registry entry
      │
      │ DB TTL
      ▼
    7 days
      │
      ▼
Automatic deletion
```

This prevents Ashi@ from maintaining a permanent index of issued Ashiato
Syntax.

### 9.1 Database Minimization

The Registry should contain only:

```text
hash
visibility
```

When the database's native TTL mechanism can manage expiration, unnecessary
timestamps and metadata should not be stored.

---

## 10. Future-Dated Ashiato

Ashi@ v1 does not allow issuance of Ashiato whose specified time is in the
future relative to the issuance time.

This restriction keeps the Issuance Registry short-lived and simple.

Ashiato Syntax itself does not prohibit future dates.

Therefore:

```text
Ashiato Syntax
    └─ Future dates may be representable

Ashi@
    └─ Future-dated issuance is not supported in v1
```

Future-dated Ashiato may be considered as a separate feature in a future
version.

---

## 11. Display Control

The Registry contains a `visibility` value.

```text
visibility = public
```

means that Ashi@ may display the Ashiato.

```text
visibility = suppressed
```

means that Ashi@ must not display the Ashiato.

Changing `visibility` affects only Ashi@.

It does not delete or modify the original social network post.

---

## 12. Non-Display Requests

Ashi@ provides a mechanism for requesting that an Ashiato be hidden from
Ashi@.

The purpose is to prevent problematic or unwanted Ashiato from being
displayed on Ashi@.

Ashi@ does not attempt to delete or modify the corresponding post on the
social network.

### 12.1 Abuse Prevention

A non-display request must not be directly executable merely by calling a
public API endpoint.

The frontend's 30-second waiting period is not considered a security
mechanism by itself. The server must independently enforce the waiting
period.

A short-lived challenge should be used, for example:

```text
Client
  │
  │ Start request
  ▼
Ashi@ server
  │
  ├─ Rate Limit
  ├─ Bot challenge
  └─ Issue temporary challenge
        │
        │ wait ≥ 30 seconds
        ▼
Client
  │
  │ Complete request
  ▼
Ashi@ server
  │
  ├─ Validate challenge
  ├─ Verify elapsed time
  ├─ Verify Bot protection
  ├─ Verify Rate Limit
  └─ Verify target hash
        │
        ▼
    visibility = suppressed
```

### 12.2 Rate Limiting

Rate limits should be applied to prevent abuse through large numbers of
non-display requests.

Possible controls include:

- IP-based rate limiting
- Session-based rate limiting
- Per-hash request limiting
- Bot detection
- Short-lived request challenges

IP addresses should not be treated as permanent user identities.

---

## 13. Temporary Request Data

Data required only to process a non-display request should be temporary.

Ashi@ should not maintain a permanent moderation history or requester
database unless required for security or legal reasons.

For example, a temporary challenge may contain:

```text
challenge
target hash
creation time
```

The challenge should automatically expire after the request is completed
or times out.

---

## 14. No Ashi@ User Accounts

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

## 15. No Social Network Content Database

Ashi@ does not maintain a database of social network content.

In particular, Ashi@ does not permanently store:

- posts
- authors
- images
- audio
- comments
- social network URLs
- search results

The browser retrieves the necessary information directly from the
supported social network.

---

## 16. No Location History

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

## 17. Location Privacy

Location information can reveal:

- a person's whereabouts
- movement patterns
- living areas
- workplaces
- private locations
- other personal information

Accordingly, Ashi@ should avoid displaying unnecessarily precise
locations.

Ashi@ may use, for example, approximately 100-meter-level precision as its
default display policy.

This is an Ashi@ service policy and is not a requirement of Ashiato Syntax.

---

## 18. Display Delay

Ashi@ should not display newly created Ashiato immediately in order to
reduce the risk of real-time location tracking.

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

The exact delay is an Ashi@ service policy and is not part of the Ashiato
Syntax specification.

---

## 19. No Proof of Presence

Ashiato Syntax does not prove that the person who generated or posted the
Syntax was physically present at the specified location.

Ashi@ should not describe an Ashiato as cryptographic or authoritative
proof of physical presence.

If proof-of-presence functionality is required in the future, it should be
designed as a separate mechanism.

---

## 20. Encryption Mode

Ashiato Syntax does not provide an encryption mode in v1.

Normal Ashiato Syntax is treated as public information. Ashi@ does not technically prevent third parties from independently parsing Ashiato Syntax and creating their own maps or clients.

If future requirements show that a Secret Ashiato must cryptographically guarantee that its contents can only be obtained on site, an encryption or concealment mechanism may be designed as a separate Ashiato Syntax extension.

The v1 design does not aim to:

- technically prevent third-party display of Ashiato
- distribute or manage encryption keys
- cryptographically prove physical presence

If an encryption mode is introduced later, it should preserve the general and implementation-independent nature of Ashiato Syntax.

---

## 20. Map Architecture

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

## 26. Infrastructure Minimization

Ashi@ is designed to minimize backend infrastructure requirements.

The backend primarily provides:

- Issuance Registry
- hash lookup
- visibility-state changes
- non-display request handling

Social network search is performed by the browser.

Map rendering does not require a third-party map service.

Ashi@ does not require a large content database.

---

## 26. Privacy and Security Principles

Ashi@ follows these principles:

1. Collect as little information as possible.
2. Do not store social network posts unnecessarily.
3. Do not store social network account information.
4. Do not maintain permanent Ashiato indexes.
5. Delete Registry entries automatically after 7 days.
6. Process social network searches on the client side.
7. Do not maintain user location histories.
8. Apply location-precision and display-delay safety measures.
9. Distinguish Secret Ashiato from suppressed Ashiato in the Registry.
10. Make non-display requests resistant to automation and bulk abuse.
11. Expire temporary security data after a short period.
12. Do not introduce an encryption mode in v1; consider it as a separate extension only if future requirements justify it.

---

## 26. Legal and Policy Considerations

This architecture is designed to reduce privacy, security, and legal risks
by minimizing the information and content handled by Ashi@.

However, minimizing stored data does not eliminate legal or contractual
responsibilities.

Ashi@ should separately consider:

- applicable privacy laws
- copyright
- privacy and personality rights
- defamation
- social network terms of service
- API usage policies
- laws and regulations applicable to information distribution platforms
- requests concerning unlawful or infringing content

Ashi@ should provide an appropriate contact mechanism for legal and
rights-related requests.

A legal review should be conducted before public deployment where
appropriate.

---

## 26. Explicit Non-Goals

Ashi@ is not intended to become:

- a social network
- a social network archive
- a permanent search engine for SNS posts
- a user profiling system
- a location tracking service
- a social network account manager
- a content moderation platform for external social networks
- a long-term location database

Whenever new features are proposed, they should be evaluated against these
non-goals.

---

## 26. Design Summary

Ashi@ intentionally follows a **thin-service architecture**.

```text
                 Social Network
                       │
                 Public Search
                       │
                       ▼
                  User Browser
                       │
            ┌──────────┴──────────┐
            │                     │
            ▼                     ▼
      Syntax Processing      Ashi@ Registry
            │                     │
            │ hash                │
            └──────────►          │
                           visibility?
                               │
                     ┌─────────┴─────────┐
                     │                   │
                    yes                  no
                     │                   │
                     ▼                   ▼
                  Display             Hide
```

Ashi@ does not attempt to own or accumulate social network data.

It maintains only the minimum information necessary to identify Ashiato
Syntax issued by Ashi@ and determine how that Ashiato should be handled
on Ashi@.

> **The social network owns the content.**
>
> **The browser discovers and processes the content.**
>
> **Ashi@ provides only short-lived issuance verification and display
> control.**

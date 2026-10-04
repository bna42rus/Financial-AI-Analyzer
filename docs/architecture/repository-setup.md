# Private remote setup

Approved host: GitHub; personal private repository under the owner's identity. The accepted recommended plan is GitHub Pro after connection/payment verification. Free may be used to test the connection before purchase. A future organization requires its own appropriate plan; personal Pro does not apply to it. No remote has been created or connected.

Verify actual private repository read/write, feature branches, pull requests, named hosted checks, and access to their results. Set main protection to prevent unreviewed direct/force pushes and deletion with required checks appropriate to the selected plan. No code, credentials, original statements or actual user finance data may be exposed through public artifacts.

Private native required-reviewer deployment gates are not assumed to be included with Pro. Production approval and deployment must use a separate owner-controlled release mechanism. Ordinary checks and Staging never receive Production credentials. Promote the same tested immutable artifacts; migration compatibility determines rollback versus forward fix.

Bootstrap checks currently verify only source integrity and monetary primitives. Full build/type/lint/integration/e2e/security checks are required before automated app Staging. This draft GitHub workflow has not run remotely; bootstrap green is not release acceptance. Concrete action/library versions must undergo the normal pinning/security review before hosted release use.

Next: owner connects GitHub; verify the real access chain before purchasing long-term hosting, then create the private remote and synchronize this existing history. GitVerse is a previously considered alternative, not the selected primary host.

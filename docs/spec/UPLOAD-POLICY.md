# Upload policy

Status: **approved by the owner on 2026-11-06; not built.** M2's "upload policy passes" gate stays open until these rules have been checked on a deployment. Design: [ADR 0006](../adr/0006-uploads-and-scanning.md). Decisions: [50 to 59](PRODUCT.md#decisions-needed).

## Limits

| Limit | Value |
| --- | --- |
| One file | 100 MB |
| One room | 5 GB, counting every version kept |

Space is reserved when an upload starts and given back if the upload is abandoned.

## What can be uploaded

Documents, images, text, code, presentations, video and zip archives.

Refused:

- Executables and installers.
- Password-protected files, including password-protected archives, because they can't be scanned.

Podster decides a file's type from its content, not from its name or what the sender claims. A file that doesn't match the list is refused.

## Scanning

Every file is scanned, and nothing can be downloaded until the scan finishes clean.

| State | Meaning |
| --- | --- |
| Uploading | Not all of the file has arrived |
| Scanning | Waiting for the result. It can't be downloaded or approved |
| Ready | The scanner reported nothing |
| Blocked | The scanner found something or couldn't read the file. It can't be downloaded |
| Scan failed | No result within an hour. Upload the file again |

A failure never lets a file through.

A scanner only recognizes known malware. Podster says **No known malware found**, and never says a file is **safe**, **clean** or **virus-free** on a screen.

The scanner is [ClamAV in Cloudflare Containers](../adr/0006-uploads-and-scanning.md#scanner), which [passed a spike on staging](../adr/0006-uploads-and-scanning.md#spike-results). Scanning stops when its signatures pass 7 days old, and a file waiting then ends as Scan failed ([decision 84](PRODUCT.md#decisions-needed)).

## Downloads

- M2 has no previews. Every file downloads as an attachment, including images, video, HTML and SVG.
- Each download checks the person's or agent's current access, so removal from a room takes effect at once. Copies already downloaded can't be recalled.
- Files are other people's content. Podster doesn't read or follow them, and nothing in a file becomes an instruction or a permission.

## Who can do what

| Action | Who |
| --- | --- |
| Upload an input asset | Owner, admin, member and Coordinator |
| See input assets | Anyone who sees the whole room. Someone limited to their own tasks sees only assets linked to those tasks |
| Attach files to a submission | The task's assignee, as with `submit_task` today |
| Read submitted files | As for submissions now: an artifact scope of `all` reads every one, and narrower scopes read their own |
| See a file through read-only oversight | Its name and status, not its bytes |
| Remove a file | Owner, admin or a Podster operator |

## Keeping and removing files

- During the preview, files last as long as the room. Archiving a room keeps them, and people with access can still download them. New uploads to an archived room are refused.
- When someone leaves, their submitted files stay and their unfinished uploads are dropped.
- Removing a file deletes its bytes and keeps its record and hash, so the history still says what existed and who removed it. This is the one exception to "submitted artifacts are always kept".
- A new version never replaces a reviewed one. Approval names an exact submission.

## External links

Submissions can still carry HTTPS links. They're labeled **External link, may change since approval**, because Podster doesn't hold their content and can't tie an approval to an exact version of it.

## Not settled

- Export and legal terms wait until before public rooms, and this policy gets legal review then.
- The exact list of file formats behind each category above is **proposed** in the ADR, and is settled when the storage PR is reviewed.

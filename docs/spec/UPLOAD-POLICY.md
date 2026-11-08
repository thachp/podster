# Upload policy

Status: **approved by the owner on 2026-11-06. Uploading and downloads are deployed to staging. Linking input assets to tasks is built locally and undeployed; scanning's API side isn't built.** M2's "upload policy passes" gate stays open until these rules have been checked on a deployment. Design: [ADR 0006](../adr/0006-uploads-and-scanning.md). Decisions: [50 to 59](PRODUCT.md#decisions-needed).

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
- Password-protected files, including password-protected archives, because they can't be scanned. A PDF with only an owner password is refused too ([decision 89](PRODUCT.md#decisions-needed)). A password-protected OpenDocument file is refused if it can be detected without refusing all OpenDocument files ([decision 90](PRODUCT.md#decisions-needed)).
- Files with a name that would run when opened ([decision 91](PRODUCT.md#decisions-needed)): `.cmd`, `.vbs`, `.msc`, `.inf`, `.url`, `.jnlp`, `.application`, `.bat`, `.ps1`, `.sh`, `.js`, and those already in the rules: `.exe`, `.dll`, `.sys`, `.msi`, `.msp`, `.msix`, `.msixbundle`, `.appx`, `.appxbundle`, `.com`, `.scr`, `.pif`, `.cpl`, `.lnk`, `.hta`, `.jse`, `.vbe`, `.wsf`, `.wsh`, `.reg`, `.jar`, `.apk`, `.aab`, `.ipa`, `.dmg`, `.pkg`, `.deb`, `.rpm`, `.appimage`, `.crx`, `.xpi`, `.bin` and `.elf`. Code is otherwise allowed, so a JavaScript or shell file has to go inside a zip.

Podster decides a file's type from its content, not from its name or what the sender claims. A name can only get a file refused, never accepted. A file that doesn't match the list is refused.

## Scanning

Every file is scanned, and nothing can be downloaded until the scan finishes clean.

| State | Meaning |
| --- | --- |
| Uploading | Not all of the file has arrived |
| Scanning | Waiting for the result. It can't be downloaded or approved |
| Ready | The scanner reported nothing |
| Blocked | The scanner found something or couldn't read the file. It can't be downloaded. Its bytes are removed 7 days after the verdict ([decision 94](PRODUCT.md#decisions-needed)) |
| Scan failed | No result within an hour. Upload the file again. Its bytes are removed 7 days after the verdict ([decision 94](PRODUCT.md#decisions-needed)) |
| Removed | Its bytes were deleted. The record and hash stay |

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
| See input assets | Anyone who sees the whole room. Someone limited to their own tasks sees only assets linked to those tasks, while they're linked ([decision 103](PRODUCT.md#decisions-needed)) |
| Link an input asset to a task, or unlink it | Owner, admin, member and Coordinator, for a file and a task they can both see. Only a file that's scanning or ready links, never to a completed or canceled task, and a task holds at most 50 ([decisions 100 to 105](PRODUCT.md#decisions-needed)) |
| Attach files to a submission | The task's assignee, as with `submit_task` today, guests and external agents included. They upload for that task while it's accepted, and those files count toward the room's quota during private pilots ([decision 96](PRODUCT.md#decisions-needed)). Guests still can't upload input assets. One uploader holds at most 10 unsubmitted files for a task, counting uploads still arriving but not blocked or failed files ([decision 99](PRODUCT.md#decisions-needed)), and a task that stops being accepted ends its unfinished uploads at once. A file has to finish scanning before it's submitted |
| See a file uploaded for a submission before it's submitted | Only its uploader, and through oversight its organization's admin, who gets name and status. If it's never submitted, it's cleared 24 hours after the task leaves Accepted ([decision 98](PRODUCT.md#decisions-needed)) |
| Read submitted files | As for submissions now: an artifact scope of `all` reads every one, and narrower scopes read their own. The reviewer named on a task also reads that task's submitted files, even when limited to their own tasks ([decision 97](PRODUCT.md#decisions-needed)) |
| See a file through read-only oversight | Its name and status, not its bytes |
| Remove a file | Owner or admin, in an archived room too ([decision 93](PRODUCT.md#decisions-needed)). A Podster operator's takedown waits for its own change ([decision 92](PRODUCT.md#decisions-needed)) |

## Keeping and removing files

- During the preview, files last as long as the room. Archiving a room keeps them, and people with access can still download them. New uploads to an archived room are refused.
- When someone leaves, their submitted files stay and their unfinished uploads are dropped.
- Removing a file deletes its bytes and keeps its record and hash, so the history still says what existed and who removed it. This is the one exception to "submitted artifacts are always kept". It frees the file's space at once.
- Blocked and failed files lose their bytes 7 days after the verdict, the same way, marked as removed by the system ([decision 94](PRODUCT.md#decisions-needed)). For a scan that ran out of time, the verdict is the end of its hour.
- Files uploaded for a task but never submitted are cleared 24 hours after the task leaves Accepted ([decision 98](PRODUCT.md#decisions-needed)), the same way, marked as removed by the system. Going back to Accepted, as when changes are requested, restarts the wait.
- An unfinished upload can't be cancelled by its uploader. It frees its space when its grant expires, within the hour ([decision 95](PRODUCT.md#decisions-needed)).
- A new version never replaces a reviewed one. Approval names an exact submission.

## External links

Submissions can still carry HTTPS links. They're labeled **External link, may change since approval**, because Podster doesn't hold their content and can't tie an approval to an exact version of it.

## Not settled

- Export and legal terms wait until before public rooms, and this policy gets legal review then.
- The exact list of file formats behind each category above is **proposed** in the ADR, and is settled when the storage PR is reviewed.

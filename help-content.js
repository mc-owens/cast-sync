// Contextual help content for the director app.
// Keyed by page filename. Each entry has an intro (1-2 sentences) and
// sections (short operational answers). Keep entries concise -- the ? panel
// is not a manual. Link to guide.html for deeper explanations.
//
// To add help for a new page: add one entry below. No other file needs to change.

(function () {
  window.HELP_CONTENT = {

    'master.html': {
      title: 'Production Timeline',
      intro: 'Your rehearsal calendar for the full production. Each column is a day of the week; rows represent rooms. Blocks show which piece rehearses when and where.',
      sections: [
        {
          heading: 'Creating a rehearsal block',
          body: 'Drag on any empty cell to place a block. Drag the right edge to adjust the duration. Click a block to open the detail drawer where you can assign a piece, set the room, view cast members, log attendance, and take notes.'
        },
        {
          heading: 'Piece colors',
          body: 'Each piece is assigned a color when created in Cast Builder. That color carries through the timeline, Cast List, and dancer schedules so everything stays visually consistent.'
        },
        {
          heading: 'Special Events',
          body: 'Performances, tech rehearsals, dress rehearsals, and other one-time events are added in Production Settings. They appear as highlighted markers along the top of the timeline.'
        },
        {
          heading: 'Org overlay',
          body: "Other productions in your organization appear as subtle background blocks. This lets you spot room conflicts across the whole organization before they happen."
        },
        {
          heading: 'Week navigation',
          body: 'Use the arrow buttons to move week by week. Set a start and end date in Production Settings to enable this. Without dates, only the current week is shown.'
        },
      ]
    },

    'search.html': {
      title: 'Casting Availability',
      intro: 'See which dancers are available for each rehearsal slot and add them to pieces directly from here.',
      sections: [
        {
          heading: 'Reading the grid',
          body: 'Columns are your rehearsal blocks, colored to match their piece on the Production Timeline. Each dancer row shows green (available), yellow (partial conflict), or red (unavailable) based on their audition form submission.'
        },
        {
          heading: 'Adding a dancer to a piece',
          body: "Click a block header to select that slot, then click a dancer's name to view their full availability profile. From there you can add them to the piece as a cast member or understudy."
        },
        {
          heading: 'Filters',
          body: 'Use the piece filter to focus on one piece\'s rehearsal slots and see only the dancers relevant to that schedule.'
        },
      ]
    },

    'cast.html': {
      title: 'Cast Builder',
      intro: 'Build a potential cast first, then find rehearsal times that work for everyone.',
      sections: [
        {
          heading: 'How it works',
          body: 'Add dancers to the Cast Members list and, if needed, the Understudies list. As you add or remove dancers, CastSync automatically compares their submitted availability and shows the times when everyone is available to rehearse.<br><br>Click a dancer\'s name at any time to view their profile, contact information, and submitted availability.'
        },
        {
          heading: 'Common Availability',
          body: 'The availability grid shows the overlap between all selected dancers\' schedules. You can switch between:<ul style="margin:8px 0 8px 0;padding-left:18px;"><li style="margin-bottom:4px;"><strong>All Windows</strong>: every time when all selected dancers are available</li><li><strong>Open Rooms</strong>: only the shared times when a rehearsal room is also available</li></ul>Existing rehearsals from the Production Timeline appear on the grid for additional scheduling context.'
        },
        {
          heading: 'Add the rehearsal when you\'re ready',
          body: 'Once you\'ve found a workable group and rehearsal time, select <strong>+ Add Rehearsal to Schedule</strong>. From there you can:<ul style="margin:8px 0 8px 0;padding-left:18px;"><li style="margin-bottom:4px;">choose an existing piece or create a new one</li><li style="margin-bottom:4px;">select one of the shared rehearsal windows</li><li>adjust the exact start and end time</li></ul>Before saving, CastSync warns you about room conflicts or dancer double-booking. When confirmed, the rehearsal is added to the Production Timeline and the selected dancers are saved to that piece as cast members or understudies.'
        },
        {
          heading: 'Cast Builder vs. Casting Availability',
          body: '<strong>Cast Builder</strong> starts with the dancers: "Can these dancers rehearse together, and when?"<br><br><strong>Casting Availability</strong> starts with the piece and its rehearsal requirements: "Which dancers can make the schedule for this piece?"'
        },
        {
          heading: 'Cast Builder vs. Cast List',
          body: '<strong>Cast Builder</strong> helps you experiment with possible groups and rehearsal times. <strong>Cast List</strong> is where you review and manage the casting that has actually been saved.'
        },
      ]
    },

    'casting.html': {
      title: 'Cast List',
      intro: 'Manage the cast for each piece and control what dancers can see.',
      sections: [
        {
          heading: 'Publish to Dancers',
          body: 'The toggle at the top controls whether cast results are visible in the dancer portal. While set to Draft, nothing is visible to dancers. Once Published, dancers with My Rehearsals enabled can see their pieces and schedules. You can return to Draft at any time.'
        },
        {
          heading: 'Email Cast',
          body: 'Send the cast list to all auditionees directly from this page. Add an optional message for rehearsal expectations, required attire, or next steps.'
        },
        {
          heading: 'Design & Export',
          body: 'Create a formatted cast list with a theme color for printing, PDF download, or CSV export — useful for posting results or sharing with parents and staff.'
        },
        {
          heading: 'Named roles',
          body: 'Toggle "Assign named roles" on any piece card to add role names next to each dancer, like "Clara" or "Lead Soloist." Role names appear on the published list and in cast emails.'
        },
        {
          heading: 'Reordering and moving dancers',
          body: 'Drag dancers to reorder within Cast Members or Understudies. Drag across sections to change their role. To add more dancers to a piece, use Cast Builder or Casting Availability.'
        },
      ]
    },

    'production-settings.html': {
      title: 'Production Settings',
      intro: 'Core configuration for this production: dates, access controls, and what dancers can see.',
      sections: [
        {
          heading: 'Join Code',
          body: 'Share this code with dancers so they can find and complete the audition form for this production. Each production has its own unique code.'
        },
        {
          heading: 'Production Dates',
          body: 'Setting a start and end date enables week-by-week navigation on the Production Timeline. The Audition Date appears as a marker on the timeline.'
        },
        {
          heading: 'Special Events',
          body: 'Add one-time events: performances, tech rehearsals, dress rehearsals, fittings, and more. Events marked visible will appear in dancer schedules. Performances show with a special highlight on the timeline.'
        },
        {
          heading: 'Submission Window',
          body: 'Controls whether dancers can submit new audition forms or update existing ones. Toggle manually or set an automatic deadline to close submissions at a specific date and time.'
        },
        {
          heading: 'Student Access',
          body: '"Enable My Rehearsals" lets cast members view their rehearsal schedule in the dancer portal. This only takes effect once casting is also published from the Cast List page.'
        },
      ]
    },

    'dashboard.html': {
      title: 'Dashboard',
      intro: 'An overview of your production\'s current state and quick access to common tasks.',
      sections: [
        {
          heading: 'Alerts',
          body: 'The alert cards at the top flag things that need attention: pending absence requests, unpublished casting, missing production dates, and similar issues. They disappear once resolved.'
        },
        {
          heading: 'Quick Actions',
          body: 'Shortcuts to the most common destinations. These do not do anything differently than navigating via the sidebar.'
        },
      ]
    },

    'dancers.html': {
      title: 'Auditionees',
      intro: 'Everyone who has submitted an audition form for this production.',
      sections: [
        {
          heading: 'Submissions vs profiles',
          body: 'Each row is a submission for this production. A dancer may appear in multiple productions but their submission data is specific to this one.'
        },
        {
          heading: 'Audition numbers',
          body: 'If your audition form includes an audition number field, it appears here and in Casting Availability search results. Useful for numbered audition formats where directors do not know names.'
        },
        {
          heading: 'Availability data',
          body: "Availability shown comes from what each dancer marked on their submission form. It feeds into the colored grid on Casting Availability."
        },
      ]
    },

    'attendance.html': {
      title: 'Attendance',
      intro: 'Track who attends each rehearsal and view attendance history by piece or dancer.',
      sections: [
        {
          heading: 'Marking attendance',
          body: 'Select a rehearsal date and piece, then mark each dancer as present, absent, or late. Attendance is saved per rehearsal block.'
        },
        {
          heading: 'Approved absences',
          body: 'Dancers with approved absence requests for that date are flagged automatically so you can quickly distinguish excused absences from unexcused ones.'
        },
      ]
    },

    'absence-requests.html': {
      title: 'Absence Requests',
      intro: 'Review and respond to absence requests submitted by dancers.',
      sections: [
        {
          heading: 'Approve or deny',
          body: 'Approving an absence marks it as excused in Attendance and shows a callout in the Production Timeline drawer for that rehearsal date. Denying removes it from pending without affecting attendance.'
        },
        {
          heading: 'Where requests come from',
          body: 'Dancers submit absence requests from their portal. They specify a date, time range, and optionally a piece. You will receive an email notification if production note notifications are enabled.'
        },
      ]
    },

    'notes.html': {
      title: 'Production Notes',
      intro: 'Shared notes visible to all directors and staff on this production.',
      sections: [
        {
          heading: 'Who sees these',
          body: 'Production Notes are shared across all directors and any staff members assigned to this production. They are not visible to dancers.'
        },
        {
          heading: 'Notifications',
          body: 'When a note is posted, CastSync emails directors who have production note notifications enabled. Toggle this in Production Settings under Notifications.'
        },
        {
          heading: 'vs My Private Notes',
          body: 'Production Notes are for the team. My Private Notes are only visible to you. When saving a note from the drawer on the Production Timeline, you can choose which destination to use.'
        },
      ]
    },

    'my-notes.html': {
      title: 'My Private Notes',
      intro: 'Personal notes only you can see. Nothing here is shared with other directors or dancers.',
      sections: [
        {
          heading: 'Saving from the timeline drawer',
          body: 'When you open a rehearsal block on the Production Timeline and go to the Notes tab, you can choose to save to My Private Notes or to Production Notes. Private notes land here.'
        },
        {
          heading: 'Context prefixes',
          body: 'Notes saved from the drawer are automatically prefixed with the piece name, day, time, and date so you can quickly see what rehearsal they relate to.'
        },
      ]
    },

    'faculty.html': {
      title: 'Faculty',
      intro: 'Add staff members to pieces so they can access rehearsal schedules, cast lists, attendance, and notes for their assigned pieces.',
      sections: [
        {
          heading: 'Staff vs Director',
          body: 'Directors have full access to all production tools. Staff members have a limited view: only the pieces they are assigned to, and no access to production-wide settings or auditionee data.'
        },
        {
          heading: 'Adding a staff member',
          body: 'Staff are added per piece from the Cast List page (expand a piece card and use the Production Staff section). They must have a CastSync account or will be prompted to create one.'
        },
      ]
    },

    'form-builder.html': {
      title: 'Audition Form',
      intro: 'Build the form dancers use to submit their audition and availability information.',
      sections: [
        {
          heading: 'Form fields',
          body: 'Add, remove, and reorder fields. Standard fields like name and email are always included. Custom fields let you collect piece preferences, experience notes, headshot uploads, or anything else you need.'
        },
        {
          heading: 'Sharing the form',
          body: 'Dancers access the form using the Join Code from Production Settings. Share the code directly or link them to your audition page.'
        },
        {
          heading: 'Availability fields',
          body: 'The availability field type generates the colored grid in Casting Availability. Dancers mark which days and times they are free and that data drives the availability analysis.'
        },
      ]
    },

  };
})();

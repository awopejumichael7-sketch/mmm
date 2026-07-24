/* ==========================================================================
   COURSE CATALOG - CAC Good Works Assembly Believers Bible College
   Exactly 10 dedicated courses, each with its own teacher slot, ebook,
   handbook, syllabus, audio, video, assignments, exams and certificate.
   Admin can edit these live in Firestore (collection "courses"); this file
   is only the seed/default data used the first time the app runs.
   ========================================================================== */
export const DEFAULT_COURSES = [
  { id: "c01", code: "BBC101", title: "Man in Three dimensions", teacherId: "", color: "#1e3a8a" },
  { id: "c02", code: "BBC102", title: "Redemption Realities I", teacherId: "", color: "#0f766e" },
  { id: "c03", code: "BBC121", title: "Redemption Realities II", teacherId: "", color: "#b45309" },
  { id: "c04", code: "BBC103", title: "Understanding Faith and Confession", teacherId: "", color: "#7c2d12" },
  { id: "c05", code: "BBC104", title: "Understanding the Principles of Prayer", teacherId: "", color: "#4c1d95" },
  { id: "c06", code: "BBC105", title: "Your Primary Responsibility I (Soul Winning)", teacherId: "", color: "#831843" },
  { id: "c07", code: "BBC151", title: "Your Primary Responsibility II (Service)", teacherId: "", color: "#134e4a" },
  { id: "c08", code: "BBC106", title: "Giving - Your key to Abundance", teacherId: "", color: "#1e293b" },
  { id: "c09", code: "BBC107", title: "Love", teacherId: "", color: "#78350f" },
  { id: "c10", code: "BBC108", title: "Growing up as a Believer", teacherId: "", color: "#3730a3" }
];

export async function seedCourses(db, collection, doc, setDoc, getDocs, COL) {
  const snap = await getDocs(collection(db, COL.courses));
  if (!snap.empty) return; // already seeded
  for (const c of DEFAULT_COURSES) {
    await setDoc(doc(db, COL.courses, c.id), {
      ...c,
      createdAt: new Date().toISOString(),
      studentCount: 0
    });
  }
}

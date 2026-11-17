import java.io.{ByteArrayInputStream, ByteArrayOutputStream, DataInputStream, DataOutputStream}
import scala.collection.mutable

object Binary:
  final class Reader(bytes: Array[Byte]) extends DataInputStream(new ByteArrayInputStream(bytes)):
    def u1(): Int = readUnsignedByte()
    def u2(): Int = readUnsignedShort()
    def u4(): Int = readInt()
    def bytes(length: Int): Array[Byte] = readNBytes(length)
    def counted[A](read: => A): Vector[A] = Vector.fill(u2())(read)
  final class Writer extends DataOutputStream(new ByteArrayOutputStream):
    def u1(value: Int): Unit = writeByte(value)
    def u2(value: Int): Unit = writeShort(value)
    def u4(value: Int): Unit = writeInt(value)
    def bytes(value: Array[Byte]): Unit = write(value)
    def counted[A](values: Seq[A])(write: A => Unit): Unit =
      u2(values.size)
      values.foreach(write)
    def result: Array[Byte] = out.asInstanceOf[ByteArrayOutputStream].toByteArray
  def encode(write: Writer => Unit): Array[Byte] =
    val output = new Writer
    write(output)
    output.result

// Floating-point constants retain their bits, including NaN payloads. Utf8 retains its
// original modified-UTF-8 bytes; only newly interned strings go through writeUTF.
enum Constant:
  case Vacant
  case Utf8(encoded: Vector[Byte])
  case Integer(bits: Int)
  case Float(bits: Int)
  case Long(bits: scala.Long)
  case Double(bits: scala.Long)
  case Class(name: Int)
  case String(value: Int)
  case Field(owner: Int, signature: Int)
  case Method(owner: Int, signature: Int)
  case InterfaceMethod(owner: Int, signature: Int)
  case NameAndType(name: Int, descriptor: Int)
  case Handle(kind: Int, reference: Int)
  case MethodType(descriptor: Int)
  case Dynamic(bootstrap: Int, signature: Int)
  case InvokeDynamic(bootstrap: Int, signature: Int)
  case Module(name: Int)
  case Package(name: Int)

  def width: Int = this match
    case Long(_) | Double(_) => 2
    case _ => 1

  def write(out: Binary.Writer): Unit =
    def one(tag: Int, index: Int): Unit = { out.u1(tag); out.u2(index) }
    def two(tag: Int, first: Int, second: Int): Unit = { one(tag, first); out.u2(second) }
    this match
      case Vacant => ()
      case Utf8(bytes) => out.u1(1); out.u2(bytes.size); out.bytes(bytes.toArray)
      case Integer(bits) => out.u1(3); out.u4(bits)
      case Float(bits) => out.u1(4); out.u4(bits)
      case Long(bits) => out.u1(5); out.writeLong(bits)
      case Double(bits) => out.u1(6); out.writeLong(bits)
      case Class(name) => one(7, name)
      case String(value) => one(8, value)
      case Field(owner, signature) => two(9, owner, signature)
      case Method(owner, signature) => two(10, owner, signature)
      case InterfaceMethod(owner, signature) => two(11, owner, signature)
      case NameAndType(name, descriptor) => two(12, name, descriptor)
      case Handle(kind, reference) => out.u1(15); out.u1(kind); out.u2(reference)
      case MethodType(descriptor) => one(16, descriptor)
      case Dynamic(bootstrap, signature) => two(17, bootstrap, signature)
      case InvokeDynamic(bootstrap, signature) => two(18, bootstrap, signature)
      case Module(name) => one(19, name)
      case Package(name) => one(20, name)

  def remapped(index: Int => Int): Constant = this match
    case Utf8(_) | Integer(_) | Float(_) | Long(_) | Double(_) => this
    case Class(name) => Class(index(name))
    case String(value) => String(index(value))
    case Field(owner, signature) => Field(index(owner), index(signature))
    case Method(owner, signature) => Method(index(owner), index(signature))
    case InterfaceMethod(owner, signature) => InterfaceMethod(index(owner), index(signature))
    case NameAndType(name, descriptor) => NameAndType(index(name), index(descriptor))
    case MethodType(descriptor) => MethodType(index(descriptor))
    case _ => throw IllegalArgumentException(s"cannot remap constant $this")

object Constant:
  def read(in: Binary.Reader): Constant = in.u1() match
    case 1 => Utf8(in.bytes(in.u2()).toVector)
    case 3 => Integer(in.u4())
    case 4 => Float(in.u4())
    case 5 => Long(in.readLong())
    case 6 => Double(in.readLong())
    case 7 => Class(in.u2())
    case 8 => String(in.u2())
    case 9 => Field(in.u2(), in.u2())
    case 10 => Method(in.u2(), in.u2())
    case 11 => InterfaceMethod(in.u2(), in.u2())
    case 12 => NameAndType(in.u2(), in.u2())
    case 15 => Handle(in.u1(), in.u2())
    case 16 => MethodType(in.u2())
    case 17 => Dynamic(in.u2(), in.u2())
    case 18 => InvokeDynamic(in.u2(), in.u2())
    case 19 => Module(in.u2())
    case 20 => Package(in.u2())
    case tag => throw IllegalArgumentException(s"unknown constant tag $tag")

  def text(value: java.lang.String): Constant =
    val encoded = Binary.encode(_.writeUTF(value))
    Utf8(encoded.drop(2).toVector)

final case class Attribute(name: Int, body: Array[Byte]):
  def write(out: Binary.Writer): Unit =
    out.u2(name); out.u4(body.length); out.bytes(body)

object Attribute:
  def read(in: Binary.Reader): Attribute = Attribute(in.u2(), in.bytes(in.u4()))

final case class Member(access: Int, name: Int, descriptor: Int, attributes: Vector[Attribute]):
  def concrete: Boolean = (access & (0x0400 | 0x0100)) == 0
  def bridge: Boolean = (access & 0x0040) != 0
  def static: Boolean = (access & 0x0008) != 0
  def write(out: Binary.Writer): Unit =
    out.u2(access); out.u2(name); out.u2(descriptor)
    out.counted(attributes)(_.write(out))

object Member:
  def read(in: Binary.Reader): Member = Member(in.u2(), in.u2(), in.u2(), in.counted(Attribute.read(in)))

final case class InnerClass(inner: Int, outer: Int, name: Int, access: Int):
  def write(out: Binary.Writer): Unit =
    out.u2(inner); out.u2(outer); out.u2(name); out.u2(access)
  def remapped(index: Int => Int): InnerClass = copy(inner = index(inner), outer = index(outer), name = index(name))

final case class ClassFile(minor: Int, major: Int, pool: Vector[Constant], access: Int,
                           thisClass: Int, superClass: Int, interfaces: Vector[Int],
                           fields: Vector[Member], methods: Vector[Member], attributes: Vector[Attribute]):
  def text(index: Int): String = pool(index) match
    case Constant.Utf8(bytes) =>
      new Binary.Reader(Binary.encode { out => out.u2(bytes.size); out.bytes(bytes.toArray) }).readUTF()
    case constant => throw IllegalArgumentException(s"expected Utf8 at $index, got $constant")
  def className(index: Int): String = pool(index) match
    case Constant.Class(name) => text(name)
    case constant => throw IllegalArgumentException(s"expected Class at $index, got $constant")
  def name: String = className(thisClass)
  def key(member: Member): String = s"${text(member.name)}:${text(member.descriptor)}"
  def overload(member: Member): String = key(member).takeWhile(_ != ')') + ")"
  def named(attributes: Vector[Attribute], name: String): Option[Attribute] = attributes.find(attribute => text(attribute.name) == name)
  def nested: Vector[InnerClass] = named(attributes, "InnerClasses").toVector.flatMap: attribute =>
    val in = new Binary.Reader(attribute.body)
    in.counted(InnerClass(in.u2(), in.u2(), in.u2(), in.u2()))
  def outer: Option[String] = nested.find(entry => entry.inner == thisClass && entry.outer != 0 && (entry.access & 8) == 0)
    .map(entry => className(entry.outer).replace('/', '.'))

  def parameterNames(member: Member): Vector[Int] =
    val variables = named(member.attributes, "Code").toVector.flatMap: attribute =>
      val in = new Binary.Reader(attribute.body)
      in.u2(); in.u2(); in.bytes(in.u4())
      in.bytes(8 * in.u2())
      in.counted(Attribute.read(in)).filter(attribute => text(attribute.name) == "LocalVariableTable").flatMap: table =>
        val entries = new Binary.Reader(table.body)
        entries.counted:
          val start = entries.u2()
          entries.u2()
          val name = entries.u2()
          entries.u2()
          val slot = entries.u2()
          (start, slot, name)
    var slot = if member.static then 0 else 1
    Descriptor.parameters(text(member.descriptor)).map: parameter =>
      val name = variables.find { case (start, index, _) => start == 0 && index == slot }.map(_._3).getOrElse(0)
      slot += parameter.slots
      name

  def bytes: Array[Byte] = Binary.encode: out =>
    out.u4(0xcafebabe); out.u2(minor); out.u2(major); out.u2(pool.size)
    pool.foreach(_.write(out))
    out.u2(access); out.u2(thisClass); out.u2(superClass)
    out.counted(interfaces)(out.u2)
    out.counted(fields)(_.write(out)); out.counted(methods)(_.write(out)); out.counted(attributes)(_.write(out))

object ClassFile:
  def read(bytes: Array[Byte]): ClassFile =
    val in = new Binary.Reader(bytes)
    require(in.u4() == 0xcafebabe, "not a classfile")
    val minor = in.u2()
    val major = in.u2()
    val count = in.u2()
    val pool = mutable.ArrayBuffer[Constant](Constant.Vacant)
    while pool.size < count do
      val constant = Constant.read(in)
      pool += constant
      if constant.width == 2 then pool += Constant.Vacant
    ClassFile(minor, major, pool.toVector, in.u2(), in.u2(), in.u2(), in.counted(in.u2()),
      in.counted(Member.read(in)), in.counted(Member.read(in)), in.counted(Attribute.read(in)))

enum JavaType:
  case Primitive(name: String, width: Int)
  case Reference(name: String)
  case Array(element: JavaType)

  def canonical: String = this match
    case Primitive(name, _) => name
    case Reference(name) => name.replace('/', '.')
    case Array(element) => element.canonical + "[]"
  def slots: Int = this match
    case Primitive(_, width) => width
    case _ => 1

object Descriptor:
  def parameters(descriptor: String): Vector[JavaType] =
    var cursor = 1
    def read(): JavaType =
      val tag = descriptor(cursor)
      cursor += 1
      tag match
        case '[' => JavaType.Array(read())
        case 'L' =>
          val end = descriptor.indexOf(';', cursor)
          val name = descriptor.substring(cursor, end)
          cursor = end + 1
          JavaType.Reference(name)
        case 'B' => JavaType.Primitive("byte", 1)
        case 'C' => JavaType.Primitive("char", 1)
        case 'D' => JavaType.Primitive("double", 2)
        case 'F' => JavaType.Primitive("float", 1)
        case 'I' => JavaType.Primitive("int", 1)
        case 'J' => JavaType.Primitive("long", 2)
        case 'S' => JavaType.Primitive("short", 1)
        case 'Z' => JavaType.Primitive("boolean", 1)
        case _ => throw IllegalArgumentException(s"bad descriptor $descriptor")
    val parameters = Vector.newBuilder[JavaType]
    while descriptor(cursor) != ')' do parameters += read()
    parameters.result()
